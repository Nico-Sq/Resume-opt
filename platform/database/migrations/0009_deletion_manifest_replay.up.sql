select set_config('search_path', quote_ident(current_schema()), true);

alter table deletion_events
  add column event_sequence bigint generated always as identity;
alter table deletion_events
  add constraint deletion_events_event_sequence_unique unique (event_sequence);

create function read_deletion_manifest_events()
returns table(
  event_sequence bigint,
  event_id uuid,
  resource_type text,
  resource_id uuid,
  user_id uuid,
  event_type text,
  revision bigint,
  occurred_at timestamptz,
  restore_until timestamptz,
  policy_version integer,
  trace_id uuid
)
language sql
stable
security definer
set search_path from current
as $$
  select e.event_sequence, e.id, e.resource_type, e.resource_id, e.user_id,
         e.event_type, e.revision, e.occurred_at, e.restore_until, e.policy_version,
         e.trace_id
    from deletion_events e
   order by e.event_sequence
$$;

create function acknowledge_deletion_manifest(
  p_manifest_id uuid,
  p_event_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path from current
as $$
declare
  v_requested integer;
  v_distinct integer;
  v_existing integer;
  v_marked integer;
begin
  if p_manifest_id is null or p_event_ids is null then
    raise exception 'manifest id and event ids are required';
  end if;

  select count(*)::integer, count(distinct event_id)::integer
    into v_requested, v_distinct
    from unnest(p_event_ids) as events(event_id);
  if v_requested <> v_distinct then
    raise exception 'manifest event ids must be unique';
  end if;
  if v_requested = 0 then
    return 0;
  end if;

  select count(*)::integer into v_existing
    from deletion_events
   where id = any(p_event_ids);
  if v_existing <> v_requested then
    raise exception 'manifest contains unknown deletion events';
  end if;

  update deletion_events
     set manifest_export_id = p_manifest_id,
         manifest_exported_at = clock_timestamp()
   where id = any(p_event_ids)
     and manifest_exported_at is null;
  get diagnostics v_marked = row_count;
  return v_marked;
end
$$;

revoke all on function read_deletion_manifest_events() from public;
revoke all on function acknowledge_deletion_manifest(uuid, uuid[]) from public;
revoke all on function read_deletion_manifest_events()
  from resume_opt_app, resume_opt_auth;
revoke all on function acknowledge_deletion_manifest(uuid, uuid[])
  from resume_opt_app, resume_opt_auth;
grant execute on function read_deletion_manifest_events() to resume_opt_privacy;
grant execute on function acknowledge_deletion_manifest(uuid, uuid[]) to resume_opt_privacy;
