select set_config('search_path', quote_ident(current_schema()), true);

drop function if exists acknowledge_deletion_manifest(uuid, uuid[]);
drop function if exists read_deletion_manifest_events();
alter table deletion_events drop constraint if exists deletion_events_event_sequence_unique;
alter table deletion_events drop column if exists event_sequence;
