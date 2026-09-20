create table auth_rate_limits (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  key text not null,
  count integer not null,
  last_request bigint not null,
  constraint auth_rate_limits_key_unique unique (key),
  constraint auth_rate_limits_count_check check (count >= 1)
);

revoke all on auth_rate_limits from public;
revoke all on auth_rate_limits from resume_opt_app;
grant select, insert, update, delete on auth_rate_limits to resume_opt_auth;
