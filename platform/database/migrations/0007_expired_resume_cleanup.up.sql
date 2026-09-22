select set_config('search_path', quote_ident(current_schema()), true);

do $$
begin
  if to_regrole('resume_opt_privacy') is null then
    raise exception 'required role resume_opt_privacy is missing';
  end if;
end
$$;

alter table idempotency_requests
  add column resource_type text default nullif(current_setting('app.resource_type', true), ''),
  add column resource_id uuid default nullif(current_setting('app.resource_id', true), '')::uuid;

update idempotency_requests
   set resource_type = 'resume',
       resource_id = case operation
         when 'resume.save' then (response_body ->> 'resumeId')::uuid
         when 'resume.rename' then (response_body #>> '{resume,id}')::uuid
         when 'resume.create' then (response_body ->> 'resumeId')::uuid
         when 'resume.copy' then (response_body ->> 'resumeId')::uuid
         when 'resume.delete' then (response_body ->> 'id')::uuid
         when 'resume.undelete' then (response_body #>> '{resume,id}')::uuid
       end
 where operation in (
   'resume.save', 'resume.rename', 'resume.create',
   'resume.copy', 'resume.delete', 'resume.undelete'
 );

alter table idempotency_requests add constraint idempotency_resource_pair_check check (
  (resource_type is null and resource_id is null)
  or (resource_type = 'resume' and resource_id is not null)
);
alter table idempotency_requests add constraint idempotency_resume_resource_check check (
  operation not like 'resume.%'
  or (resource_type = 'resume' and resource_id is not null)
);
create index idempotency_resource_idx
  on idempotency_requests(resource_type, resource_id)
  where resource_id is not null;

alter function mutate_resume_lifecycle(text, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid)
  rename to mutate_resume_lifecycle_v1;
revoke all on function mutate_resume_lifecycle_v1(text, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid)
  from public, resume_opt_app, resume_opt_auth;

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
begin
  perform set_config('app.resource_type', 'resume', true);
  perform set_config('app.resource_id', p_resume_id::text, true);
  return query
    select * from mutate_resume_lifecycle_v1(
      p_operation, p_resume_id, p_key, p_request_hash, p_base_revision,
      p_version_id, p_event_id, p_audit_id, p_trace_id
    );
end
$$;

revoke all on function mutate_resume_lifecycle(text, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid)
  from public;
grant execute on function mutate_resume_lifecycle(text, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid)
  to resume_opt_app;

alter table deletion_events
  add column manifest_export_id uuid,
  add column manifest_exported_at timestamptz;
alter table deletion_events add constraint deletion_events_manifest_pair_check check (
  (manifest_export_id is null and manifest_exported_at is null)
  or (manifest_export_id is not null and manifest_exported_at is not null)
);
alter table deletion_events drop constraint deletion_events_event_type_check;
alter table deletion_events add constraint deletion_events_event_type_check
  check (event_type in ('soft_delete', 'restore', 'hard_delete'));

create function purge_expired_resumes(
  p_limit integer,
  p_dry_run boolean,
  p_run_id uuid
) returns table(
  selected_count integer,
  purged_count integer,
  blocked_unexported_count integer,
  versions_deleted integer,
  receipts_deleted integer,
  audits_deleted integer,
  oldest_overdue_seconds bigint
)
language plpgsql
security definer
set search_path from current
as $$
declare
  v_resume record;
  v_selected integer := 0;
  v_purged integer := 0;
  v_blocked integer := 0;
  v_versions integer := 0;
  v_receipts integer := 0;
  v_audits integer := 0;
  v_count integer;
  v_oldest bigint;
begin
  if p_limit < 1 or p_limit > 100 or p_run_id is null then
    raise exception 'cleanup limit must be between 1 and 100 and run id is required';
  end if;

  select count(*)::integer,
         coalesce(extract(epoch from (clock_timestamp() - min(r.restore_until)))::bigint, 0)
    into v_blocked, v_oldest
    from resumes r
   where r.deleted_at is not null
     and r.restore_until <= clock_timestamp()
     and not exists (
       select 1
         from deletion_events e
        where e.resume_id = r.id
          and e.revision = r.revision
          and e.event_type = 'soft_delete'
          and e.manifest_exported_at is not null
     );

  if p_dry_run then
    select count(*)::integer
      into v_selected
      from (
        select r.id
          from resumes r
         where r.deleted_at is not null
           and r.restore_until <= clock_timestamp()
           and exists (
             select 1
               from deletion_events e
              where e.resume_id = r.id
                and e.revision = r.revision
                and e.event_type = 'soft_delete'
                and e.manifest_exported_at is not null
           )
         order by r.restore_until, r.id
         limit p_limit
      ) candidates;
    return query select v_selected, 0, v_blocked, 0, 0, 0, v_oldest;
    return;
  end if;

  for v_resume in
    select r.id, r.user_id, r.revision, r.restore_until
      from resumes r
     where r.deleted_at is not null
       and r.restore_until <= clock_timestamp()
       and exists (
         select 1
           from deletion_events e
          where e.resume_id = r.id
            and e.revision = r.revision
            and e.event_type = 'soft_delete'
            and e.manifest_exported_at is not null
       )
     order by r.restore_until, r.id
     for update of r skip locked
     limit p_limit
  loop
    v_selected := v_selected + 1;

    update resume_versions
       set source_version_id = null
     where resume_id = v_resume.id and source_version_id is not null;
    delete from resume_versions where resume_id = v_resume.id;
    get diagnostics v_count = row_count;
    v_versions := v_versions + v_count;

    delete from idempotency_requests
     where resource_type = 'resume' and resource_id = v_resume.id;
    get diagnostics v_count = row_count;
    v_receipts := v_receipts + v_count;

    delete from audit_events
     where (resource_type = 'resume' and resource_id = v_resume.id)
        or metadata ->> 'sourceResumeId' = v_resume.id::text;
    get diagnostics v_count = row_count;
    v_audits := v_audits + v_count;

    insert into deletion_events
      (id, resume_id, user_id, event_type, revision, occurred_at,
       restore_until, policy_version, trace_id)
    values
      (gen_random_uuid(), v_resume.id, v_resume.user_id, 'hard_delete',
       v_resume.revision + 1, clock_timestamp(), null, 1, p_run_id);

    insert into audit_events
      (id, actor_user_id, action, resource_type, resource_id,
       trace_id, result_code, metadata)
    values
      (gen_random_uuid(), v_resume.user_id, 'resume.hard_delete', 'resume', v_resume.id,
       p_run_id, 'HARD_DELETED',
       jsonb_build_object('actorType', 'privacy_cleanup',
                          'revision', (v_resume.revision + 1)::text,
                          'policyVersion', 1));

    delete from resumes where id = v_resume.id;
    v_purged := v_purged + 1;
  end loop;

  return query select v_selected, v_purged, v_blocked, v_versions,
                      v_receipts, v_audits, v_oldest;
end
$$;

revoke all on function purge_expired_resumes(integer, boolean, uuid) from public;
revoke all on function purge_expired_resumes(integer, boolean, uuid)
  from resume_opt_app, resume_opt_auth;
do $$
begin
  execute format('grant usage on schema %I to resume_opt_privacy', current_schema());
end
$$;
grant execute on function purge_expired_resumes(integer, boolean, uuid)
  to resume_opt_privacy;
