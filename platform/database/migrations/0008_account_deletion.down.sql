drop function if exists purge_deleted_accounts(integer, boolean, uuid);
drop function if exists record_account_auth_revocation(uuid, text);
drop function if exists accept_account_deletion(uuid, text, uuid, uuid, uuid, uuid);
drop table if exists privacy_requests;
alter table deletion_events drop constraint if exists deletion_events_resource_revision_unique;
alter table deletion_events drop constraint if exists deletion_events_resource_check;
alter table deletion_events drop constraint if exists deletion_events_event_type_check;
alter table deletion_events drop column if exists resource_id;
alter table deletion_events drop column if exists resource_type;
delete from deletion_events where event_type = 'account_delete';
alter table deletion_events alter column resume_id set not null;
alter table deletion_events add constraint deletion_events_event_type_check
  check (event_type in ('soft_delete', 'restore', 'hard_delete'));
alter table deletion_events add constraint deletion_events_resume_revision_unique
  unique (resume_id, revision);
