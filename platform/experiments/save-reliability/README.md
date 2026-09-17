# Save Reliability Experiment

该目录验证 V0.1 完整快照保存协议，不是正式应用实现。它覆盖客户端 ACK 顺序、冻结重试信封、PostgreSQL revision CAS、幂等回执、事务回滚、所有权隐藏和数据库角色隔离。

## 运行

前置条件是 `platform/.env.local` 已由一次性数据库初始化脚本生成，且该文件不得提交。

```powershell
Set-Location E:\Resume-opt\platform
pnpm typecheck
pnpm test:save
```

数据库测试在 `resume_opt_test` 内创建随机 schema，结束后清理；不会改动开发库业务表。`db:setup` 只用于首次建立隔离数据库和角色，已存在时会拒绝覆盖。

## 边界

- `Snapshot` 是最小测试模型，不可复制为正式 Resume Schema。
- 协调器是协议模型，不包含 React、Dexie 或 HTTP Route Handler。
- PostgreSQL Store 用来证明事务性质，不代替 Drizzle 迁移、RLS 和正式仓储。
- 公开测试前必须把固定开发身份替换为真实认证，并重跑跨账户测试。
