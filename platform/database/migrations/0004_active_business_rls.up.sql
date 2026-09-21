drop policy users_owner on users;
drop policy resumes_owner on resumes;
drop policy resume_versions_owner on resume_versions;
drop policy idempotency_owner on idempotency_requests;
drop policy audit_owner on audit_events;

create policy users_owner on users for all to resume_opt_app
  using (
    id = nullif(current_setting('app.user_id', true), '')::uuid
    and status = 'active'
    and deleted_at is null
  )
  with check (
    id = nullif(current_setting('app.user_id', true), '')::uuid
    and status = 'active'
    and deleted_at is null
  );

create policy resumes_owner on resumes for all to resume_opt_app
  using (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and deleted_at is null
    and exists (select 1 from users where users.id = resumes.user_id)
  )
  with check (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and deleted_at is null
    and exists (select 1 from users where users.id = resumes.user_id)
  );

create policy resume_versions_owner on resume_versions for all to resume_opt_app
  using (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and exists (
      select 1 from resumes
       where resumes.id = resume_versions.resume_id
         and resumes.user_id = resume_versions.user_id
    )
  )
  with check (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and exists (
      select 1 from resumes
       where resumes.id = resume_versions.resume_id
         and resumes.user_id = resume_versions.user_id
    )
  );

create policy idempotency_owner on idempotency_requests for all to resume_opt_app
  using (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and exists (select 1 from users where users.id = idempotency_requests.user_id)
  )
  with check (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and exists (select 1 from users where users.id = idempotency_requests.user_id)
  );

create policy audit_owner on audit_events for all to resume_opt_app
  using (
    actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and exists (select 1 from users where users.id = audit_events.actor_user_id)
  )
  with check (
    actor_user_id = nullif(current_setting('app.user_id', true), '')::uuid
    and exists (select 1 from users where users.id = audit_events.actor_user_id)
  );
