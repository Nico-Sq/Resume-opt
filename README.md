# AI 简历平台

面向中国大陆用户的 AI 简历编辑与优化平台。V0.1 受控候选版已验收，现进入已批准的 V0.2 公开多用户基础开发；正式代码当前仍使用固定测试身份和简历，不能公开部署。V0.2 范围为邮箱认证、多简历工作台、账户隔离及删除/恢复，不包含 AI、JD、完整诊断、额度、会员或支付；PDF、导出、分享待重新排期。

## 当前进度

- 已完成正式 Monorepo、运行配置和 PostgreSQL 角色隔离。
- 已完成 Resume Schema V1、初始迁移、固定开发身份和固定简历初始化。
- 已提供编辑器启动与简历读取接口，并通过所有权、RLS、损坏数据和幂等初始化测试。
- 已完成编辑领域命令、单一正文 Store、撤销/重做和共享 A4 Renderer，并通过边界分页与生产构建验证。
- 已完成可访问模块管理 UI：拖拽与键盘排序、显隐、恢复默认、自定义模块、独立面板收起和实时预览联动。
- 已完成服务端保存内核：完整快照 PUT、ETag/If-Match 乐观并发、不可变版本、规范化内容哈希和幂等回执。
- 已完成 IndexedDB 持久草稿：按账户/简历/标签页隔离工作副本、远端基线和待确认保存信封，支持刷新恢复、账户清理保护和 JSON 救援导出。
- 已完成可靠保存协调器：单 in-flight、800ms 防抖、主动 flush、冻结信封、原键重试、ACK 序号和本地/云端独立状态；真实浏览器已验证保存后刷新可从 PostgreSQL 回读。
- 已完成冲突与离开恢复：412 后暂停自动上传，展示 base/local/remote 三方变更概览，支持导出本地副本、采用服务器版本或显式重定基线提交，并为未确认修改提供离开提示。
- 已完成固定入口编辑闭环：全部简历模块使用真实字段、月份、列表、文本块和链接控件，支持条目折叠/复制/删除；编辑、预览、保存 ACK 与刷新回读已经自动化和真实浏览器验证。
- V01-016 已完成：`844f4ee` 对应 [Actions 35426248904](https://github.com/Nico-Sq/Resume-opt/actions/runs/35426248904) 的完整验证、原生 Chrome + IndexedDB、独立 `pg_dump/pg_restore` 恢复及脱敏证据上传均成功。后续界面修复 `444d646` 仍需对应新 CI，不能套用历史绿色结果。
- 用户已批准 V0.2 计划；先同步路线，再按 V02-002—005 验收视口、工具栏、分页和真实功能入口。真实认证尚未实现；托管 PITR 和大陆公开发布外部条件仍需落实。

详细状态参见 [V0.1 交付计划](./v0.1-delivery-plan.md) 和 [V0.2 详细计划任务书](./v0.2-delivery-plan.md)。

## 仓库结构

```text
.
├─ platform/          正式产品代码（Next.js + TypeScript + PostgreSQL）
│  ├─ apps/web/       Web 应用与 Route Handlers
│  ├─ packages/       领域、应用、基础设施、渲染器、UI 和配置包
│  ├─ database/       数据库迁移和 Drizzle 定义
│  ├─ experiments/    保存可靠性验证实验
│  └─ tests/          单元测试与数据库集成测试
├─ prototype-test/    React + Vite 可用性测试原型
├─ product-design.md  产品范围与业务设计
├─ ux-interaction-spec.md
├─ design.mf          视觉设计规范
└─ technical-selection.md
```

`output/prototypes/` 只存放可重复导出的图片，不进入版本控制。测试原型实际使用的视觉资源位于 `prototype-test/public/prototypes/`。

## 技术栈

- Next.js App Router、React、TypeScript
- PostgreSQL、Drizzle ORM、Zod
- pnpm workspace、Vitest、ESLint、Prettier、dependency-cruiser
- React + Vite 测试原型

正式架构和工程约束见 [技术选型文档](./technical-selection.md)。

## 环境要求

- Node.js `20.19.0`
- pnpm `10.28.2`
- 可访问的 PostgreSQL 实例
- Windows PowerShell（当前开发和验证环境；其他系统可使用等价命令）

## 启动正式项目

```powershell
Set-Location platform
corepack enable
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
```

编辑 `platform/.env.local`，为开发应用、迁移和测试分别配置最小权限数据库账号。不要提交真实密码或连接串。

```powershell
pnpm test:migrations
pnpm db:migrate
pnpm db:seed:dev
pnpm dev
```

本地固定身份只允许在 `local` 或 `test` 环境使用。生产环境必须接入真实认证，浏览器不能指定或切换 `userId`。

当前服务端入口：

- `GET /api/health/live`
- `GET /api/health/ready`
- `GET /api/v1/editor-bootstrap`
- `GET /api/v1/resumes/:id`
- `PUT /api/v1/resumes/:id/document`

## 运行测试原型

```powershell
Set-Location prototype-test
npm ci
npm test
npm run dev
```

原型只在浏览器本地模拟 AI、诊断、导出和支付，不调用真实 AI、不连接正式后端、不发生真实支付。测试操作记录保存在 `localStorage`，可导出为 JSON。

## 质量门禁

在 `platform/` 下运行：

```powershell
pnpm ci:fast
pnpm ci:full
pnpm test:integration
pnpm test:migrations
pnpm test:save
pnpm test:browser
pnpm ops:restore:native
pnpm build
```

`ci:full` 不包含原生浏览器和原生恢复两项，需分别执行；数据库相关命令使用隔离测试配置。在根目录运行 `node scripts/validate-technical-selection.mjs` 检查路线、链接和任务依赖。

推送到 `main` 或创建 Pull Request 时，[GitHub `verify` 工作流](https://github.com/Nico-Sq/Resume-opt/actions/workflows/verify.yml) 会在临时 PostgreSQL 实例上执行完整门禁，并独立执行浏览器和原生恢复步骤，保留 14 天的脱敏性能、恢复和数据库初始化证据。V0.2 的 CI 证据保留 30 天是 V02-032 待实施目标，不是当前配置。

提交信息遵循 Conventional Commits，例如：

```text
feat: 新增简历创建和编辑功能
fix: 修复右侧面板无法收起的问题
docs: 补充数据库和API设计文档
```

## 产品与设计文档

- [产品设计](./product-design.md)
- [UX 交互规范](./ux-interaction-spec.md)
- [视觉设计规范](./design.mf)
- [技术选型](./technical-selection.md)
- [V0.1 交付计划](./v0.1-delivery-plan.md)
- [V0.2 详细计划任务书](./v0.2-delivery-plan.md)

## 安全说明

- `.env.local`、数据库密码、令牌和本机构建产物必须保持未跟踪。
- 示例配置只能使用占位凭据。
- 如发现安全问题，请不要在公开 Issue 中粘贴密钥、用户数据或完整数据库连接串。
