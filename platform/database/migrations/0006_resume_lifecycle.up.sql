select set_config('search_path', quote_ident(current_schema()), true);

alter table resumes add column restore_until timestamptz;
update resumes
   set restore_until = deleted_at + interval '7 days'
 where deleted_at is not null;
alter table resumes add constraint resumes_deletion_window_check check (
  (deleted_at is null and restore_until is null)
  or (deleted_at is not null and restore_until > deleted_at)
);

alter table resume_versions drop constraint resume_versions_reason_check;
alter table resume_versions add constraint resume_versions_reason_check
  check (reason in ('autosave', 'edit', 'delete', 'restore', 'initial'));

create table deletion_events (
  id uuid primary key,
  resume_id uuid not null,
  user_id uuid not null,
  event_type text not null check (event_type in ('soft_delete', 'restore')),
  revision bigint not null check (revision >= 1),
  occurred_at timestamptz not null,
  restore_until timestamptz,
  policy_version integer not null default 1 check (policy_version = 1),
  trace_id uuid not null,
  constraint deletion_events_resume_revision_unique unique (resume_id, revision)
);

create index deletion_events_user_occurred_idx
  on deletion_events(user_id, occurred_at desc, id desc);
create index resumes_user_deleted_id_idx
  on resumes(user_id, deleted_at desc, id desc)
  where deleted_at is not null;

alter table deletion_events enable row level security;
revoke all on deletion_events from public, resume_opt_app;

create function mutate_resume_lifecycle(
  p_operation text,
  p_resume_id uuid,
  p_key uuid,
  p_request_hash text,
  p_base_revision bigint,
  p_version_id uuid,
  p_event_id uuid,
  p_audit_id uuid,
  p_trace_id uuid
) returns table(result_status text, response_body jsonb, current_revision bigint)
language plpgsql
security definer
set search_path from current
as $$
declare
  v_user_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_resume resumes%rowtype;
  v_existing idempotency_requests%rowtype;
  v_now timestamptz;
  v_deadline timestamptz;
  v_renderer_version text;
  v_content_hash text;
  v_response jsonb;
  v_operation text := 'resume.' || p_operation;
begin
  if p_operation not in ('delete', 'undelete') or v_user_id is null then
    return query select 'not_found', null::jsonb, null::bigint;
    return;
  end if;

  select r.* into v_resume
    from resumes r
   where r.id = p_resume_id
     and r.user_id = v_user_id
     and exists (
       select 1 from users u
        where u.id = v_user_id and u.status = 'active' and u.deleted_at is null
     )
   for update;
  if not found then
    return query select 'not_found', null::jsonb, null::bigint;
    return;
  end if;

  insert into idempotency_requests
    (user_id, operation, key, request_hash, status, expires_at)
  values (v_user_id, v_operation, p_key, p_request_hash, 'processing',
          clock_timestamp() + interval '7 days')
  on conflict do nothing;
  if not found then
    select i.* into v_existing
      from idempotency_requests i
     where i.user_id = v_user_id and i.operation = v_operation and i.key = p_key
     for update;
    if v_existing.request_hash <> p_request_hash then
      return query select 'key_reused', null::jsonb, null::bigint;
    elsif v_existing.status <> 'completed' or v_existing.response_body is null then
      return query select 'in_progress', null::jsonb, null::bigint;
    else
      return query select 'replayed', v_existing.response_body, null::bigint;
    end if;
    return;
  end if;

  if (p_operation = 'delete' and v_resume.deleted_at is not null)
     or (p_operation = 'undelete' and v_resume.deleted_at is null) then
    return query select 'not_found', null::jsonb, null::bigint;
    return;
  end if;
  if v_resume.revision <> p_base_revision then
    return query select 'conflict', null::jsonb, v_resume.revision;
    return;
  end if;

  v_now := clock_timestamp();
  if p_operation = 'undelete' and v_now > v_resume.restore_until then
    return query select 'expired', null::jsonb, null::bigint;
    return;
  end if;
  v_deadline := case when p_operation = 'delete' then v_now + interval '7 days'
                     else v_resume.restore_until end;

  select rv.renderer_version, rv.content_hash
    into v_renderer_version, v_content_hash
    from resume_versions rv
   where rv.resume_id = p_resume_id and rv.revision = v_resume.revision;
  if not found then
    raise exception 'current resume version is missing';
  end if;

  update resumes
     set revision = revision + 1,
         updated_at = v_now,
         deleted_at = case when p_operation = 'delete' then v_now else null end,
         restore_until = case when p_operation = 'delete' then v_deadline else null end
   where id = p_resume_id;

  insert into resume_versions
    (id, resume_id, user_id, revision, title_snapshot, schema_version,
     template_id, template_version, renderer_version, snapshot, content_hash, reason)
  values
    (p_version_id, p_resume_id, v_user_id, v_resume.revision + 1, v_resume.title,
     v_resume.schema_version, v_resume.template_id, v_resume.template_version,
     v_renderer_version, v_resume.document, v_content_hash,
     case when p_operation = 'delete' then 'delete' else 'restore' end);

  insert into deletion_events
    (id, resume_id, user_id, event_type, revision, occurred_at, restore_until, trace_id)
  values
    (p_event_id, p_resume_id, v_user_id,
     case when p_operation = 'delete' then 'soft_delete' else 'restore' end,
     v_resume.revision + 1, v_now, v_deadline, p_trace_id);

  if p_operation = 'delete' then
    v_response := jsonb_build_object(
      'id', p_resume_id,
      'revision', (v_resume.revision + 1)::text,
      'deletedAt', v_now,
      'restoreUntil', v_deadline,
      'versionId', p_version_id
    );
  else
    v_response := jsonb_build_object(
      'resume', jsonb_build_object(
        'id', p_resume_id,
        'title', v_resume.title,
        'locale', v_resume.document ->> 'locale',
        'stage', v_resume.document ->> 'stage',
        'revision', (v_resume.revision + 1)::text,
        'templateId', v_resume.template_id,
        'templateVersion', v_resume.template_version,
        'createdAt', v_resume.created_at,
        'updatedAt', v_now
      ),
      'versionId', p_version_id
    );
  end if;

  update idempotency_requests
     set status = 'completed', response_body = v_response
   where user_id = v_user_id and operation = v_operation and key = p_key;
  insert into audit_events
    (id, actor_user_id, action, resource_type, resource_id, trace_id, result_code, metadata)
  values
    (p_audit_id, v_user_id, v_operation, 'resume', p_resume_id, p_trace_id,
     case when p_operation = 'delete' then 'DELETED' else 'RESTORED' end,
     jsonb_build_object('revision', (v_resume.revision + 1)::text,
                        'versionId', p_version_id,
                        'policyVersion', 1));

  return query select 'completed', v_response, null::bigint;
end
$$;

create function list_deleted_resumes(
  p_limit integer,
  p_after_deleted_at timestamptz default null,
  p_after_id uuid default null
) returns table(
  id uuid,
  title text,
  locale text,
  stage text,
  revision bigint,
  template_id text,
  template_version text,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz,
  restore_until timestamptz
)
language sql
security definer
set search_path from current
stable
as $$
  select r.id, r.title, r.document ->> 'locale', r.document ->> 'stage', r.revision,
         r.template_id, r.template_version, r.created_at, r.updated_at,
         r.deleted_at, r.restore_until
    from resumes r
   where r.user_id = nullif(current_setting('app.user_id', true), '')::uuid
     and r.deleted_at is not null
     and r.restore_until >= clock_timestamp()
     and exists (
       select 1 from users u
        where u.id = r.user_id and u.status = 'active' and u.deleted_at is null
     )
     and (
       p_after_deleted_at is null
       or (r.deleted_at, r.id) < (p_after_deleted_at, p_after_id)
     )
   order by r.deleted_at desc, r.id desc
   limit p_limit
$$;

revoke all on function mutate_resume_lifecycle(text, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid)
  from public;
revoke all on function list_deleted_resumes(integer, timestamptz, uuid) from public;
grant execute on function mutate_resume_lifecycle(text, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid)
  to resume_opt_app;
grant execute on function list_deleted_resumes(integer, timestamptz, uuid) to resume_opt_app;
