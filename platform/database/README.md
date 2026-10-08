# 数据库迁移

迁移由 `resume_opt_migrator` 执行，Web 应用只能使用 `resume_opt_app`。迁移脚本按文件名顺序执行，并在同一事务中记录 SHA-256；已执行文件发生变化时立即失败。

```powershell
Set-Location E:\Resume-opt\platform
pnpm test:migrations
pnpm db:migrate
```

`db:migrate` 会修改开发库 `public` schema，只能在迁移测试通过并明确准备启用开发数据后执行。当前自动化测试使用随机临时 schema，不修改 `public` 业务表。

`.down.sql` 只作为本地或测试环境的人工回滚说明，不由生产发布自动执行。生产结构变更采用新的前向迁移；涉及删列或改类型时遵循 expand → migrate → contract。

## V0.2 升级与应用回滚

支持的数据库路径是空库升级到当前版本、已带数据的0001库前向升级到当前版本，以及当前版本迁移复跑no-op。迁移器会在同一事务内持有schema级 advisory lock、核对每个已执行文件的SHA-256；校验和变化或任一迁移中断都会回滚本次全部未提交变更。

```powershell
Set-Location E:\Resume-opt\platform
pnpm ops:rollback:rehearse
```

该命令只允许本地/测试配置，在 `resume_opt_dev` 中创建随机隔离schema，装载合成V0.1数据，前向升级后依次验证旧读取合同、当前版本写入、兼容应用回滚写入、CAS和运行角色权限，最后删除隔离schema。报告只写入已忽略的 `artifacts/test/rollback/`，不包含简历正文或数据库连接串。

生产回滚只允许切回已支持当前数据库合同、具备真实Auth的前一V0.2应用构建，或关闭入口后forward-fix。以下路径明确禁止：对生产执行 `.down.sql`、回退到fixed-only V0.1构建、为通过回滚而删除已创建的用户/Session/注销事件，或把隔离演练当作真实旧二进制部署、staging和生产PITR证据。
