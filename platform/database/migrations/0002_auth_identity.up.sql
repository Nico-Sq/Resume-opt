create table auth_users (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  name text not null,
  email text not null,
  email_verified boolean not null default false,
  image text,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now(),
  constraint auth_users_email_unique unique (email),
  constraint auth_users_business_user_fk foreign key (id) references users(id)
);

create table auth_sessions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  expires_at timestamp not null,
  token text not null,
  created_at timestamp not null default now(),
  updated_at timestamp not null,
  ip_address text,
  user_agent text,
  user_id uuid not null references auth_users(id) on delete cascade,
  constraint auth_sessions_token_unique unique (token)
);

create table auth_accounts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  account_id text not null,
  provider_id text not null,
  user_id uuid not null references auth_users(id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamp,
  refresh_token_expires_at timestamp,
  scope text,
  password text,
  created_at timestamp not null default now(),
  updated_at timestamp not null
);

create table auth_verifications (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  identifier text not null,
  value text not null,
  expires_at timestamp not null,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

create index "auth_accounts_userId_idx" on auth_accounts(user_id);
create index "auth_sessions_userId_idx" on auth_sessions(user_id);
create index "auth_verifications_identifier_idx" on auth_verifications(identifier);

create function bridge_auth_user() returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception using
      errcode = '23000',
      message = 'auth user id is immutable';
  end if;

  execute format(
    'insert into %I.users(id, status, display_name) values ($1, ''active'', $2)',
    tg_table_schema
  ) using new.id, new.name;
  return new;
end
$$;

revoke all on function bridge_auth_user() from public;

create trigger auth_users_bridge
  before insert on auth_users
  for each row execute function bridge_auth_user();

create trigger auth_users_id_immutable
  before update of id on auth_users
  for each row execute function bridge_auth_user();

revoke all on auth_users, auth_sessions, auth_accounts, auth_verifications from public;
revoke all on auth_users, auth_sessions, auth_accounts, auth_verifications from resume_opt_app;
grant select, insert, update, delete
  on auth_users, auth_sessions, auth_accounts, auth_verifications
  to resume_opt_auth;

do $$
begin
  execute format(
    'alter default privileges for role %I in schema %I revoke select, insert, update, delete on tables from resume_opt_app',
    current_user,
    current_schema()
  );
end
$$;
