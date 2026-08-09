# 跨境电商平台收入与平台成本测算工具

本项目是独立的 TypeScript 模块化单体：Vue 3 + Vite SPA、Fastify API、独立 Node.js Worker、PostgreSQL 17、pg-boss 持久队列和 AWS Encryption SDK framed AEAD 文件存储。业务口径以 `nas/doc/1-技术架构/软件设计说明书.md` 为准。

## 本地初始化

要求 Node.js 24、pnpm 9.15 和 PostgreSQL 17。Windows 一键启动器可以启动本机已安装且与 `DATABASE_URL` 端口匹配的 PostgreSQL 集群，但不会安装、初始化、停止或重建数据库。

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
# 编辑 .env.local：配置独立数据库、至少 32 字节 HMAC 密钥和规范的 32 字节 Base64 FILE_KEK_BASE64。
pnpm db:status
pnpm db:migrate
$env:BOOTSTRAP_ADMIN_PHONE='<E.164 管理员手机号>'
pnpm db:bootstrap-admin
pnpm db:bootstrap-mappings
```

手机号仅作为本地示例输入，不要把真实号码、密钥或生产凭据写入仓库。首位管理员初始化是数据库内的并发安全一次性操作。

## 运行

Windows 本地开发可直接双击 `bin\start.cmd`。启动器会检查 Node、pnpm、`.env.local` 与 PostgreSQL；如果 `DATABASE_URL` 指向本机但数据库未监听，会启动已安装且与目标端口匹配的 PostgreSQL Windows 集群（普通用户无权启动服务时，使用同一 `pg_ctl` 和数据目录启动）。随后幂等应用待执行迁移，隐藏启动 API、Worker 和对局域网开放的 Vite，并在 API readiness、页面及代理链路均通过后打开 `PUBLIC_ORIGIN`。如果配置的是已不属于本机的旧私有 IPv4，启动器会按当前默认路由选取局域网 IPv4，并以同一个进程级 Origin 启动和检查 API/Vite，避免 DHCP 换网段后等待旧地址。启动成功后窗口会显示本次实际可用的 `HOST` 和完整 `URL`；直接双击时窗口保留，复制后按任意键关闭。运行日志写入 `.work/startup/`；启动器不会安装、初始化、停止或重建 PostgreSQL。

如需手动启动，在三个终端分别执行：

```powershell
pnpm dev:api
pnpm dev:worker
pnpm dev:web -- --host 0.0.0.0
```

Vite 使用 5173 端口，局域网入口以 `.env.local` 中无尾斜杠的 `PUBLIC_ORIGIN` 为准；API 默认为 `http://127.0.0.1:3000`。开发模式的 OTP 与支付均为显式沙箱；不得用于真实交易。

### CLI 日志诊断

API 每个请求输出一条 JSON 终态事件，可按页面错误响应中的 `requestId` 或稳定 `errorCode` 检索。启动器同时维护 `.work/startup/current-api.json` 等当前进程清单，`bin/logs.ps1` 只输出诊断白名单字段，不回显请求体、查询值、手机号、验证码、Cookie 或令牌。

```powershell
.\bin\logs.ps1 -Service api -Tail 20
.\bin\logs.ps1 -Service api -ErrorCode ACCOUNT_NOT_REGISTERED
.\bin\logs.ps1 -Service api -RequestId '<页面返回的 requestId>'
```

终态事件固定使用 `http_request_completed`，结果为 `SUCCEEDED`、`REJECTED`、`FAILED`、`ABORTED` 或 `TIMED_OUT`；服务端失败最多附带稳定错误类型、系统码和 `src/...:行:列` 项目相对位置。

## 质量门禁

```powershell
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

需要 PostgreSQL 的集成套件通过各自的 `MIGRATION_TEST_DATABASE_URL`、`AUTH_BILLING_TEST_DATABASE_URL`、`FX_INTEGRATION_DATABASE_URL` 和 `REPORT_ACCEPTANCE_DATABASE_URL` 指向隔离测试库。2GB、浏览器、备份和 PITR 验收脚本写入 `.work/acceptance`，不得指向业务样例目录。

## 生产停止条件

生产模式必须使用真实短信/支付适配配置、ChinaMoney 官方 HTTPS 接入、独立密钥托管、远端对象副本、异机加密数据库备份与 WAL/PITR、有效域名/TLS，并具备新鲜的恢复演练证据；任一条件缺失时 readiness 失败闭合。`ops/` 仅提供部署配置示例，不会执行部署。

完整迁移、验收证据和仍需外部解除的门禁见 `nas/doc/2-交付/首版验收报告.md`。
