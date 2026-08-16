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

### 一键发布（先演练，后人工确认）

`bin\push.cmd` 是受控的代码制品更新器，不是数据同步工具。首次或每次变更后先运行本地演练：

```powershell
.\bin\push.cmd -DryRun
```

演练会执行 `pnpm verify:release`，只打包 `dist/`、`migrations/`、`package.json`、`pnpm-lock.yaml` 与锁文件匹配的既有 Linux x64 生产依赖，并反向扫描禁项；演练在进入任何 `ssh`/`scp` 语句前结束。确认演练结果后，执行 `.\bin\push.cmd`，并按提示输入大写 `PUSH` 才会连接服务器。

发布固定校验 SSH 主机指纹，先上传 `.partial`，再在新版本目录离线校验依赖、比较本地/上一版本/生产库三份迁移文件名与 SHA-256。该入口不接受新增或改写迁移，不上传 `.env*`、`nas/data/`、本地对象存储、测试、Git 元数据、本地 `node_modules` 或数据库转储；因此本地测试数据不会进入制品。远端切换前创建 root-only PostgreSQL 恢复点，原子切换 `current` 后验证 API、Worker 与内外网 live/ready；失败只切回上一代码版本并保留恢复点和失败版本供诊断。服务器已有业务数据、对象存储和配置目录不会被复制或覆盖；后续业务正常使用产生的新数据不属于发布脚本影响。

新增或改写依赖、迁移、服务、Nginx 或生产配置不属于这个一键入口，必须单独审查发布。脚本不会执行管理员初始化、内置映射初始化或“空库”断言。

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
pnpm verify          # 无数据库单元/合约测试 + lint + build（build 内含 typecheck）
pnpm test:postgres   # 在 TEST_DATABASE_URL 基库中每套件创建并销毁随机 schema
pnpm test:report-acceptance # 在同一测试基库的独立随机 schema 中自建夹具并清理
pnpm test:ui-contract
pnpm verify:release  # 上述测试、报告验收和 UI 合约的发布总门禁
```

`pnpm test` 不含数据库套件，也不使用 skip 把缺失环境伪装为通过。常规 PostgreSQL 集成测试和报告验收只读取 `TEST_DATABASE_URL`，每套件在基库中创建独立随机 schema、自建确定性夹具并在结束后清理。恢复演练只能使用独立的 `OPERATIONS_TEST_SOURCE_DATABASE_URL` 和 `OPERATIONS_TEST_RESTORE_DATABASE_URL` 运行 `pnpm test:recovery`。2GB 和 PITR 验收产物写入 `.work/acceptance`，不得指向业务样例目录。

## 生产停止条件

正式生产模式必须使用真实短信/支付适配配置、ChinaMoney 官方 HTTPS 接入、独立密钥托管、远端对象副本、异机加密数据库备份与 WAL/PITR、有效域名/TLS，并具备新鲜的恢复演练证据；任一条件缺失时 readiness 失败闭合。经用户于 2026-08-10 明确批准的固定码受控试运行是唯一例外：必须显式启用 `TEMPORARY_DEGRADED_PRODUCTION`；启用 `TEMPORARY_PUBLIC_REGISTRATION` 后，任意手机号可用运维侧固定码注册为 `ACCOUNTANT` 并直接进入已登录状态，换绑手机号仍关闭，管理员授权保持应用现有逻辑。`PAYMENT_PROVIDER=temporary-manual` 可开放受控即时到账，但不连接真实支付渠道，也不得表述为外部支付成功；ChinaMoney 仍失败闭合，readiness 返回 `degraded`，不得表述为正式生产就绪。公网不使用额外 Basic Auth，访问控制由 OTP 限流、Origin/CSRF 和会话校验承担。`ops/` 仅提供部署配置示例，不会执行部署。

完整迁移、验收证据和仍需外部解除的门禁见 `nas/doc/2-交付/首版验收报告.md`。
