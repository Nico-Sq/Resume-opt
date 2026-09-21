drop policy users_owner on users;
drop policy resumes_owner on resumes;
drop policy resume_versions_owner on resume_versions;
drop policy idempotency_owner on idempotency_requests;
drop policy audit_owner on audit_events;

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
