drop function if exists list_deleted_resumes(integer, timestamptz, uuid);
drop function if exists mutate_resume_lifecycle(text, uuid, uuid, text, bigint, uuid, uuid, uuid, uuid);
drop index if exists resumes_user_deleted_id_idx;
drop table if exists deletion_events;
alter table resume_versions drop constraint if exists resume_versions_reason_check;
alter table resume_versions add constraint resume_versions_reason_check
  check (reason in ('autosave', 'edit', 'restore', 'initial'));
alter table resumes drop constraint if exists resumes_deletion_window_check;
alter table resumes drop column if exists restore_until;
