-- 仅用于本地/测试环境人工回滚。生产环境优先使用前向修复迁移。
-- 执行前必须确认 search_path 指向本次目标 schema，且已经完成备份。
drop table if exists audit_events;
drop table if exists idempotency_requests;
drop table if exists resume_versions;
drop table if exists resumes;
drop table if exists templates;
drop table if exists users;
drop table if exists schema_migrations;
