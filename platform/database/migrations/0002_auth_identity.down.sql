-- 仅用于没有真实账户的本地/隔离测试库。
drop trigger if exists auth_users_id_immutable on auth_users;
drop trigger if exists auth_users_bridge on auth_users;
drop function if exists bridge_auth_user();
drop table if exists auth_sessions;
drop table if exists auth_accounts;
drop table if exists auth_verifications;
drop table if exists auth_users;
