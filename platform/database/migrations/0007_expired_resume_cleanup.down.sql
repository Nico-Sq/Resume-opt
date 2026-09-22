drop function if exists purge_expired_resumes(integer, boolean, uuid);
drop function if exists mutate_resume_lifecycle(text, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid);
alter function mutate_resume_lifecycle_v1(text, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid)
  rename to mutate_resume_lifecycle;
grant execute on function mutate_resume_lifecycle(text, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid)
  to resume_opt_app;
drop index if exists idempotency_resource_idx;
alter table deletion_events drop constraint if exists deletion_events_manifest_pair_check;
alter table deletion_events drop constraint if exists deletion_events_event_type_check;
alter table deletion_events add constraint deletion_events_event_type_check
  check (event_type in ('soft_delete', 'restore'));
alter table deletion_events drop column if exists manifest_exported_at;
alter table deletion_events drop column if exists manifest_export_id;
alter table idempotency_requests drop constraint if exists idempotency_resume_resource_check;
alter table idempotency_requests drop constraint if exists idempotency_resource_pair_check;
alter table idempotency_requests drop column if exists resource_id;
alter table idempotency_requests drop column if exists resource_type;
