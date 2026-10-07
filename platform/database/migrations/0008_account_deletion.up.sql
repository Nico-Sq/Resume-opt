select set_config('search_path', quote_ident(current_schema()), true);

alter table deletion_events
  drop constraint deletion_events_resume_revision_unique;
alter table deletion_events
  alter column resume_id drop not null,
  add column resource_type text generated always as (
    case when event_type = 'account_delete' then 'account' else 'resume' end
  ) stored,
  add column resource_id uuid generated always as (coalesce(resume_id, user_id)) stored;
alter table deletion_events drop constraint deletion_events_event_type_check;
alter table deletion_events add constraint deletion_events_event_type_check
  check (event_type in ('soft_delete', 'restore', 'hard_delete', 'account_delete'));
alter table deletion_events add constraint deletion_events_resource_check check (
  (resource_type = 'resume' and resume_id is not null and resource_id = resume_id)
  or (resource_type = 'account' and resume_id is null and resource_id = user_id)
);
alter table deletion_events add constraint deletion_events_resource_revision_unique
  unique (resource_type, resource_id, revision);

create table privacy_requests (
  id uuid primary key,
  user_id uuid not null,
  request_type text not null check (request_type = 'account_delete'),
  status text not null check (status in ('accepted', 'completed')),
  idempotency_key uuid not null,
  request_hash text not null,
  requested_at timestamptz not null,
  cleanup_due_at timestamptz not null,
  auth_revoked_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  constraint privacy_requests_user_type_unique unique (user_id, request_type),
  constraint privacy_requests_completion_check check (
    (status = 'accepted' and completed_at is null)
    or (status = 'completed' and completed_at is not null)
  )
);

create index privacy_requests_cleanup_idx
  on privacy_requests(status, requested_at, id)
  where status = 'accepted';
alter table privacy_requests enable row level security;
create policy privacy_requests_owner on privacy_requests for select to resume_opt_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
revoke all on privacy_requests from public, resume_opt_app, resume_opt_auth, resume_opt_privacy;

create function accept_account_deletion(
  p_key uuid,
  p_request_hash text,
  p_request_id uuid,
  p_event_id uuid,
  p_audit_id uuid,
  p_trace_id uuid
) returns table(result_status text, request_id uuid, requested_at timestamptz)
language plpgsql
security definer
set search_path from current
as $$
declare
  v_user_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_existing privacy_requests%rowtype;
  v_now timestamptz;
begin
  if v_user_id is null or p_key is null or p_request_hash = '' then
    return query select 'not_found', null::uuid, null::timestamptz;
    return;
  end if;

  select * into v_existing
    from privacy_requests
   where user_id = v_user_id and request_type = 'account_delete'
   for update;
  if found then
    if v_existing.idempotency_key <> p_key or v_existing.request_hash <> p_request_hash then
      return query select 'key_reused', null::uuid, null::timestamptz;
    end if;
    return query select 'replayed', v_existing.id, v_existing.requested_at;
    return;
  end if;

  perform 1 from users
   where id = v_user_id and status = 'active' and deleted_at is null
   for update;
  if not found then
    return query select 'not_found', null::uuid, null::timestamptz;
    return;
  end if;

  v_now := clock_timestamp();
  insert into privacy_requests
    (id, user_id, request_type, status, idempotency_key, request_hash,
     requested_at, cleanup_due_at)
  values
    (p_request_id, v_user_id, 'account_delete', 'accepted', p_key, p_request_hash,
     v_now, v_now + interval '24 hours');

  update users
     set status = 'disabled', deleted_at = v_now, updated_at = v_now
   where id = v_user_id;

  insert into deletion_events
    (id, resume_id, user_id, event_type, revision, occurred_at,
     restore_until, policy_version, trace_id)
  values
    (p_event_id, null, v_user_id, 'account_delete', 1, v_now,
     null, 1, p_trace_id);

  insert into audit_events
    (id, actor_user_id, action, resource_type, resource_id,
     trace_id, result_code, metadata)
  values
    (p_audit_id, v_user_id, 'account.delete', 'account', v_user_id,
     p_trace_id, 'ACCEPTED', jsonb_build_object('requestId', p_request_id,
                                                'policyVersion', 1));

  return query select 'completed', p_request_id, v_now;
end
$$;

create function record_account_auth_revocation(
  p_request_id uuid,
  p_error_code text default null
) returns void
language plpgsql
security definer
set search_path from current
as $$
begin
  update privacy_requests
     set auth_revoked_at = case when p_error_code is null then clock_timestamp()
                                else auth_revoked_at end,
         last_error_code = p_error_code
   where id = p_request_id
     and user_id = nullif(current_setting('app.user_id', true), '')::uuid
     and status = 'accepted';
end
$$;

create function purge_deleted_accounts(
  p_limit integer,
  p_dry_run boolean,
  p_run_id uuid
) returns table(
  selected_count integer,
  purged_count integer,
  blocked_unexported_count integer,
  resumes_deleted integer,
  versions_deleted integer,
  receipts_deleted integer,
  audits_deleted integer,
  auth_sessions_deleted integer,
  auth_accounts_deleted integer,
  auth_verifications_deleted integer,
  auth_users_deleted integer,
  oldest_overdue_seconds bigint
)
language plpgsql
security definer
set search_path from current
as $$
declare
  v_request record;
  v_selected integer := 0;
  v_purged integer := 0;
  v_blocked integer := 0;
  v_resumes integer := 0;
  v_versions integer := 0;
  v_receipts integer := 0;
  v_audits integer := 0;
  v_sessions integer := 0;
  v_accounts integer := 0;
  v_verifications integer := 0;
  v_auth_users integer := 0;
  v_count integer;
  v_oldest bigint;
begin
  if p_limit < 1 or p_limit > 100 or p_run_id is null then
    raise exception 'cleanup limit must be between 1 and 100 and run id is required';
  end if;

  select count(*)::integer,
         greatest(0, coalesce(extract(epoch from (clock_timestamp() - min(pr.cleanup_due_at)))::bigint, 0))
    into v_blocked, v_oldest
    from privacy_requests pr
   where pr.status = 'accepted'
     and not exists (
       select 1 from deletion_events e
        where e.resource_type = 'account'
          and e.resource_id = pr.user_id
          and e.event_type = 'account_delete'
          and e.manifest_exported_at is not null
     );

  if p_dry_run then
    select count(*)::integer into v_selected
      from (
        select pr.id
          from privacy_requests pr
         where pr.status = 'accepted'
           and exists (
             select 1 from deletion_events e
              where e.resource_type = 'account'
                and e.resource_id = pr.user_id
                and e.event_type = 'account_delete'
                and e.manifest_exported_at is not null
           )
         order by pr.requested_at, pr.id
         limit p_limit
      ) candidates;
    return query select v_selected, 0, v_blocked, 0, 0, 0, 0, 0, 0, 0, 0, v_oldest;
    return;
  end if;

  for v_request in
    select pr.id, pr.user_id
      from privacy_requests pr
     where pr.status = 'accepted'
       and exists (
         select 1 from deletion_events e
          where e.resource_type = 'account'
            and e.resource_id = pr.user_id
            and e.event_type = 'account_delete'
            and e.manifest_exported_at is not null
       )
     order by pr.requested_at, pr.id
     for update of pr skip locked
     limit p_limit
  loop
    v_selected := v_selected + 1;

    update resume_versions set source_version_id = null
     where user_id = v_request.user_id and source_version_id is not null;
    delete from resume_versions where user_id = v_request.user_id;
    get diagnostics v_count = row_count;
    v_versions := v_versions + v_count;

    delete from idempotency_requests where user_id = v_request.user_id;
    get diagnostics v_count = row_count;
    v_receipts := v_receipts + v_count;

    delete from audit_events where actor_user_id = v_request.user_id;
    get diagnostics v_count = row_count;
    v_audits := v_audits + v_count;

    delete from resumes where user_id = v_request.user_id;
    get diagnostics v_count = row_count;
    v_resumes := v_resumes + v_count;

    delete from auth_verifications where value = v_request.user_id::text;
    get diagnostics v_count = row_count;
    v_verifications := v_verifications + v_count;

    delete from auth_sessions where user_id = v_request.user_id;
    get diagnostics v_count = row_count;
    v_sessions := v_sessions + v_count;

    delete from auth_accounts where user_id = v_request.user_id;
    get diagnostics v_count = row_count;
    v_accounts := v_accounts + v_count;

    delete from auth_users where id = v_request.user_id;
    get diagnostics v_count = row_count;
    v_auth_users := v_auth_users + v_count;

    delete from users where id = v_request.user_id;

    update privacy_requests
       set status = 'completed', completed_at = clock_timestamp(),
           last_error_code = null
     where id = v_request.id;
    v_purged := v_purged + 1;
  end loop;

  return query select v_selected, v_purged, v_blocked, v_resumes, v_versions,
                      v_receipts, v_audits, v_sessions, v_accounts,
                      v_verifications, v_auth_users, v_oldest;
end
$$;

revoke all on function accept_account_deletion(uuid, text, uuid, uuid, uuid, uuid) from public;
revoke all on function record_account_auth_revocation(uuid, text) from public;
revoke all on function purge_deleted_accounts(integer, boolean, uuid) from public;
revoke all on function purge_deleted_accounts(integer, boolean, uuid)
  from resume_opt_app, resume_opt_auth;
grant execute on function accept_account_deletion(uuid, text, uuid, uuid, uuid, uuid)
  to resume_opt_app;
grant execute on function record_account_auth_revocation(uuid, text) to resume_opt_app;
grant execute on function purge_deleted_accounts(integer, boolean, uuid)
  to resume_opt_privacy;
