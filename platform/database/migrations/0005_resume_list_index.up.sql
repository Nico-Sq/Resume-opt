create index resumes_user_updated_id_idx
  on resumes(user_id, updated_at desc, id desc)
  where deleted_at is null;
