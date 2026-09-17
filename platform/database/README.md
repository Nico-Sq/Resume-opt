# 数据库迁移

迁移由 `resume_opt_migrator` 执行，Web 应用只能使用 `resume_opt_app`。迁移脚本按文件名顺序执行，并在同一事务中记录 SHA-256；已执行文件发生变化时立即失败。

```powershell
Set-Location E:\Resume-opt\platform
pnpm test:migrations
pnpm db:migrate
```

`db:migrate` 会修改开发库 `public` schema，只能在迁移测试通过并明确准备启用开发数据后执行。当前自动化测试使用随机临时 schema，不修改 `public` 业务表。

`.down.sql` 只作为本地或测试环境的人工回滚说明，不由生产发布自动执行。生产结构变更采用新的前向迁移；涉及删列或改类型时遵循 expand → migrate → contract。
