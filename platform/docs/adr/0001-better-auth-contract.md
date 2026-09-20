# ADR-0001：Better Auth V0.2 合同

- 状态：已接受
- 日期：2026-09-20
- 适用任务：V02-006

## 决策

运行时精确锁定 `better-auth@1.7.5` 与 `kysely@0.28.17`。后者位于 Better Auth 声明的兼容范围内，并保持项目 Node.js 20.19.0 运行时可用。生成工具精确使用 `auth@1.7.5`；该 CLI 要求 Node.js >=22.12.0，因此只在隔离的 Node.js 24 中运行，不加入 Node.js 20 项目的依赖或运行路径。

数据库采用 Better Auth 的 Kysely PostgreSQL 路径，固定 `public` schema、`snake_case`、适配器事务和服务器 UUID。只启用邮箱密码，不启用 OAuth 或插件。配置合同位于 `packages/infrastructure/src/identity/better-auth-contract.ts`。

参考：[Better Auth 数据库](https://www.better-auth.com/docs/concepts/database)、[邮箱密码](https://www.better-auth.com/docs/authentication/email-password)、[Session](https://www.better-auth.com/docs/concepts/session-management)、[CLI](https://www.better-auth.com/docs/concepts/cli)。

## Handler 允许清单

Web handler 后续只放行下列方法和路径；Better Auth 核心中存在但不属于 V0.2 的社交登录、账户关联、资料修改、多 Session 管理等端点必须在挂载层拒绝。

| 方法 | 路径                                |
| ---- | ----------------------------------- |
| POST | `/api/auth/sign-up/email`           |
| POST | `/api/auth/sign-in/email`           |
| POST | `/api/auth/sign-out`                |
| GET  | `/api/auth/get-session`             |
| GET  | `/api/auth/verify-email`            |
| POST | `/api/auth/send-verification-email` |
| POST | `/api/auth/request-password-reset`  |
| GET  | `/api/auth/reset-password/:token`   |
| POST | `/api/auth/reset-password`          |

Session 固定为 PG 有状态存储、7 天绝对到期、关闭自动刷新、10 分钟 fresh、关闭 Cookie Session 缓存。邮箱验证 Token 24 小时有效，密码重置 Token 30 分钟有效；重置密码撤销旧 Session。运行时必须注入真实或受控 Fake 邮件回调，缺失时启动失败，不把库的“重置未启用”响应当正常功能。

业务 `GET /api/v1/session` 只投影 `{userId, displayName, emailVerified, expiresAt}`。Session ID、Token、IP、User-Agent、密码、账户凭据及邮箱不进入该响应、JS 存储或日志。

## 数据库与共享身份

锁定表名为 `auth_users`、`auth_sessions`、`auth_accounts`、`auth_verifications`。库生成的 PostgreSQL 空库差异保存在 `docs/evidence/better-auth-1.7.5-postgresql.sql`，它是审查证据，不是正式迁移。

生成结果确认：四表 ID 均为 UUID；email 和 Session token 唯一；accounts/sessions 外键指向 auth_users；验证表没有 userId。Better Auth 在写入和查找时把 email 转为小写，本期不实施 Gmail 点号或加号归并。

生成结果没有业务 `users` 外键、注册桥接、角色授权，也没有 `(provider_id, account_id)` 唯一约束。前 3 项由 V02-008 在正式 `0002` 迁移中补齐；最后一项不凭假设添加，邮箱密码账户行为由 V02-010 的真实注册/并发测试验证，发现可重现重复时再按库合同处理。

共享身份冻结为窄 BEFORE INSERT trigger：先以 `auth_users.id` 插入 `users(id,status='active',display_name)`，再由 `auth_users.id -> users.id` 外键落地。任一步失败必须在同一语句事务回滚；禁止 `ON CONFLICT DO NOTHING`，不建立身份映射表，也不认领既有 fixed 用户。

角色边界冻结如下：迁移角色拥有函数和 DDL；Auth 角色只访问 Auth 四表，不能直接写业务 users；业务应用角色不能读取密码、Session 或验证表。触发器函数使用固定 `search_path`、限定列并撤销 PUBLIC EXECUTE。正式授权和 RLS 在 V02-008 实施。

## 可见错误矩阵

| 场景                              | HTTP/结果    | 对用户的合同                       |
| --------------------------------- | ------------ | ---------------------------------- |
| 注册输入无效                      | 400          | 字段错误，不回显内部信息           |
| 已存在邮箱注册                    | 200 通用结果 | 与新邮箱同形；不确认账户存在性     |
| 邮箱或密码错误                    | 401          | 统一“邮箱或密码不正确”             |
| 正确凭据但邮箱未验证              | 403          | 提示完成验证，可受限重发           |
| 找回密码邮箱存在/不存在           | 200 通用结果 | 同状态、同文案，不确认账户存在性   |
| 验证或重置 Token 无效、过期、重复 | 400/安全跳转 | 统一无效或已过期，不返回 Token     |
| 业务 Session 缺失、过期、撤销     | 401          | 清空受保护视图；不回退 fixed       |
| Origin/CSRF 校验失败              | 403          | 通用拒绝，不关闭库保护             |
| 触发限流                          | 429          | 返回 Retry-After                   |
| 邮件或数据库内部失败              | 500/503      | 通用错误与脱敏 traceId；可安全重试 |

状态码与响应字段须在 V02-009/V02-010 用真实 handler 快照再次锁定；若 1.7.5 实际行为不同，修装配或回审合同，不自研密码端点伪装一致。

## 证据与边界

- 单元合同覆盖版本、路由、模型、UUID、有效期和无 Token Session 投影。
- PostgreSQL 临时 schema 集成测试覆盖共享 UUID 成功路径和 Auth 行失败时业务 users 行回滚。
- Node.js 20 直接运行 `auth@1.7.5` 因 `Object.groupBy` 不可用而失败；隔离 Node.js 24 可运行 CLI。
- 虚拟机 `192.168.19.200:5432` 不可达时不得声明本地集成通过；本次恢复连通后，临时 schema 桥接测试及完整集成套件均已通过。
- 本任务不挂载页面 handler、不发送邮件、不创建正式迁移、不改现有保存协议或 RLS。
