create table users (
  id uuid primary key,
  status text not null check (status in ('active', 'disabled')),
  display_name text not null check (char_length(display_name) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table templates (
  template_id text not null,
  version text not null,
  renderer_version text not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  asset_hash text not null,
  status text not null check (status in ('draft', 'published', 'retired')),
  created_at timestamptz not null default now(),
  primary key (template_id, version)
);

create table resumes (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  document jsonb not null check (jsonb_typeof(document) = 'object'),
  revision bigint not null default 0 check (revision >= 0),
  schema_version integer not null check (schema_version = 1),
  template_id text not null,
  template_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint resumes_id_user_unique unique (id, user_id),
  constraint resumes_template_fk foreign key (template_id, template_version)
    references templates(template_id, version)
);

create index resumes_user_updated_idx
  on resumes(user_id, updated_at desc)
  where deleted_at is null;

create table resume_versions (
  id uuid primary key,
  resume_id uuid not null,
  user_id uuid not null,
  revision bigint not null check (revision >= 1),
  title_snapshot text not null,
  schema_version integer not null check (schema_version = 1),
  template_id text not null,
  template_version text not null,
  renderer_version text not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  content_hash text not null,
  reason text not null check (reason in ('autosave', 'edit', 'restore', 'initial')),
  source_version_id uuid references resume_versions(id),
  created_at timestamptz not null default now(),
  constraint resume_versions_resume_revision_unique unique (resume_id, revision),
  constraint resume_versions_owner_fk foreign key (resume_id, user_id)
    references resumes(id, user_id) on delete cascade,
  constraint resume_versions_template_fk foreign key (template_id, template_version)
    references templates(template_id, version)
);

create index resume_versions_resume_revision_idx
  on resume_versions(resume_id, revision desc);

create table idempotency_requests (
  user_id uuid not null,
  operation text not null,
  key uuid not null,
  request_hash text not null,
  status text not null check (status in ('processing', 'completed')),
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, operation, key)
);

create index idempotency_expiry_idx on idempotency_requests(expires_at);

create table audit_events (
  id uuid primary key,
  actor_user_id uuid not null,
  action text not null,
  resource_type text not null,
  resource_id uuid not null,
  trace_id uuid not null,
  result_code text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index audit_events_actor_created_idx on audit_events(actor_user_id, created_at desc);

alter table users enable row level security;
alter table resumes enable row level security;
alter table resume_versions enable row level security;
alter table idempotency_requests enable row level security;
alter table audit_events enable row level security;

create policy users_owner on users for all to resume_opt_app
  using (id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.user_id', true), '')::uuid);

create policy resumes_owner on resumes for all to resume_opt_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

create policy resume_versions_owner on resume_versions for all to resume_opt_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

create policy idempotency_owner on idempotency_requests for all to resume_opt_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

create policy audit_owner on audit_events for all to resume_opt_app
  using (actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid);

grant select, insert, update on users, resumes, idempotency_requests to resume_opt_app;
grant select, insert on resume_versions, audit_events to resume_opt_app;
grant select on templates to resume_opt_app;
