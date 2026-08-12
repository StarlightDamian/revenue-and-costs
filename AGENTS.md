# revenue-and-costs 项目指令

> 本文件只补充项目专属规则。通用工作方式、授权、安全、工具、协作、验证和交付规则统一继承 `C:\Users\Damian\.codex\AGENTS.md`，不在此重复。

## 1. 当前状态与事实来源

- 本项目是已实现并持续演进的独立 Web 应用、独立配置和独立 PostgreSQL 数据库，不是 `D:\wwwroot\googcci` 的子模块，也不是“待实施”的空骨架。
- `nas/doc/1-技术架构/软件设计说明书.md` 的正文是当前业务口径、权限、架构和验收契约；文档顶部的历史状态文字不能用于判断实现进度。当前实现事实必须从 `src/`、`migrations/`、`tests/` 和本轮运行证据确认。
- `README.md` 与 `package.json` 是本地运行方式、运行时版本和命令入口的事实来源。`nas/doc/2-交付/首版验收报告.md` 及各优化状态文档是带日期的历史证据快照，其中迁移数量、测试数量、角色名、发布方式和工作簿版本不得代替当前代码与设计正文。
- `agent_revenue-and-costs.md` 是与本项目合同无关的旧工具笔记，不是指令或事实来源；保持原样，不执行其中命令。
- 需求或业务口径变更时，先同步设计说明书和对应回归测试，再修改实现；若文档、迁移、代码与测试互相冲突，先查明是新需求未落地还是实现回归，不静默选择其中一个。
- `nas/data/`、`.env.local` 和用户提供的工作簿属于本地敏感材料。不得把真实客户数据、买家 PII、来自客户材料或秘密配置的本机绝对路径、手机号、订单明细、密钥、OTP、会话令牌或支付凭据写入源码、测试夹具、日志和交付物；测试使用脱敏或合成数据，业务样例保持只读。
- `D:\wwwroot\googcci\src\googcci\portal\v0.2` 只用于登录布局、主题变量、背景素材和交互行为的视觉参考，不复制其服务端队列、上传或内存处理实现。

## 2. 当前技术与模块边界

- 当前 v1 是 TypeScript 模块化单体：Vue 3 + Vite SPA、Fastify API、独立 Node.js Worker、PostgreSQL 17、`pg-boss` 持久队列和 AWS Encryption SDK framed AEAD 文件存储。运行时固定为 Node.js `>=24 <25`、pnpm `>=9.15 <10`。
- 现有边界为 `src/web`、`src/api`、`src/worker`、`src/modules`、`src/db`、`src/shared`、`src/types`、`migrations`、`scripts` 和 `tests`。领域规则与公式放在 `src/modules`；HTTP、Worker、页面和导出不得复制另一套权限、状态机或财务公式。
- API 负责鉴权、对象级授权、轻量命令/查询、分片上传、支付回调和下载授权，不处理完整原始文件或生成标准销售成本工作簿；现有中间结果 XLSX 是有界分页、流式写出的明确例外。Worker 负责解包、解析、汇率同步、计算、自动发布、重算和标准导出。两者共享领域模型，不拆成微服务或第二套 HTTP 服务。
- PostgreSQL 是业务事实、账本、版本指针、审计、outbox 和任务状态的唯一事务数据库；原件与导出保存在加密对象存储，不写入 `bytea`。`pg-boss` 是队列租约、心跳和重试的唯一事实来源，业务进度表不得实现第二套抢占队列。
- 数据库迁移只使用可审查的前向 SQL；不重写迁移历史或删除历史账本、价格、数据版本、汇率与审计事实，修正通过新迁移和新版本完成。
- 任务与业务变更同事务入队；库能力不足时使用事务 outbox。所有处理按 at-least-once 和唯一业务键设计，先提交幂等业务结果再 ack；确定性契约错误直接进入失败终态，瞬时错误才有限重试。
- 大文件路径优先使用 Node 流、背压、PostgreSQL `COPY` 和 ExcelJS streaming writer。不得用无界 `Buffer`、整文件 `readFile`、整包解压、逐事实行 `INSERT` 或 `writeBuffer()` 处理大文件。
- 不引入 Python/Rust 子进程、Redis、Kafka、Kubernetes、ORM 或额外 HTTP 服务；只有代表性基准或明确能力缺口证明现有方案不足时，才通过 ADR 替换窄模块。

## 3. 业务、财务与发布不变量

- 平台角色只有 `ACCOUNTANT` 和 `ADMIN`；企业是公司、企业钱包和做账员协作的归属主体；`CUSTOMER` 只存在于公司级 `shop_membership` 只读关系。同一账号可以加入多个企业并成为其他公司的客户。所有资源在 API 层执行对象级授权，跨企业或公司访问失败闭合，不能只依赖前端隐藏。
- 客户只能读取已发布快照，导出默认关闭且需单独授权，永远不能下载原件；管理员下载其他主体原件必须填写原因并审计。客户关系或导出权被撤销时，关联的 `QUEUED/RUNNING/SUCCEEDED` 导出授权和旧下载令牌立即失效，下载端仍实时复核 membership。
- 企业钱包使用整数“分”和追加式账本。余额、消费、公司期限与账本在同一事务中更新；支付回调、扣款、建店/续费、导入、发布和导出均幂等。退款、撤销和拒付只追加反向账本，不能改写原记录；余额扣为负数时进入 `RESTRICTED_DEBT`，允许查看和充值但禁止新消费、建公司或续期。管理员免费建公司仍记录原价、实付 0、`ADMIN_FREE`、操作者和价格版本。
- 金额与汇率使用 PostgreSQL `numeric`、`decimal.js` 和字符串 API 值，禁止 JavaScript `number` 参与财务计算。数据库与审计链路保留 8 位小数，界面通常显示 2 位；收入、退款、平台代扣税、费用互斥分类、符号方向和平台结余以设计说明书第 11 节为准。
- 原件、原始汇率、映射、站点策略、数据版本、计算运行、发布快照、价格和审计事件不可原地改写；修正与回滚创建新版本并事务切换 current 指针，旧版本保持可追溯。
- 标准导入在预检存在可用数据且没有批次级阻断时自动入库；硬不完整已确认排除且其他质量门禁满足后，自动计算并发布固定输入的不可变快照。自动发布前必须再次核对当前数据、映射、日期归属、来源时区、策略和汇率版本。显式“发布正式结果”只用于独立重算、回滚或自动发布失败后的恢复，新快照成功前继续展示上一正式快照。
- 完整性键为“公司 + 规范化站点 + 报表字面月份 + 数据版本”，不以文件数、行数、订单数或 SKU 数是否相等判断。报表字面日期直接决定财务日期和月份，不转换到中国或站点时区；来源时区只用于生成可审计的绝对时间。缺失侧不得按 0；`HARD_INCOMPLETE` 只能被确认排除且永不进入正式汇总。`SOFT_RECONCILIATION_WARNING` 仅在两类来源完整时产生；当前标准导入以 `IMPORT_AUTO_WARNING_INCLUSION` 留下审计并带警告纳入，页面和导出持续披露。未知站点按大站点处理。
- 汇率日期使用报表显示日期；工作日必须取当天报价，只有已证明的非交易日才向后顺延，默认最多 10 个自然日。首个开市日其他报价存在而目标币对缺失时属于数据缺口并阻止发布。`100JPY/CNY`、`CNY/外币` 和非 CNY 交叉换算统一复用 `src/modules/fx`，两个非 CNY 币种使用同一命中报价日。

## 4. 导入、文件、安全与导出契约

- 浏览器目录、文件和 ZIP 使用可恢复分片上传并保留相对路径，默认批次上限 2GB；服务端限制总大小、文件数、压缩比、实际解压字节，并拒绝路径穿越、符号链接和嵌套压缩包。
- 参与计算的输入为 CSV、结构有效的制表符 TXT，以及映射已确认的配送 XLSX。PDF 只登记相对路径和元数据，不上传正文，也不提供并不存在的原件下载；XLS、交易报告 XLSX 和未满足配送映射的其他 XLSX 仍作为原件上传归档并在预检中披露，但不解析为财务事实。
- 文件类型、站点和月份由内容确定，目录名与文件名只用于诊断。混合站点按行拆分；`Non-Amazon` 不参与计算，但排除数量和金额必须守恒并可核对。
- 原件从加密暂存转为不可变信封加密对象；PostgreSQL 只保存标准化计算字段和 `source_file_id + row_number + row_hash` 等来源引用，不复制整行原始 JSONB 或买家 PII。未知表头、语言或字段映射停留在暂存区，只有管理员确认并生成不可变映射版本后才可重解析，禁止静默模糊匹配。
- 当前标准销售成本格式为 `revenue-and-costs-export-v8`，只含默认隐藏的 `口径说明`、`月度明细账单`、`季度明细账单`、`年度明细账单`、`成本核算表-人民币` 五个 Sheet；完整性、费用与导入审计保留在数据库和页面，逐金额汇率使用保留在数据库审计链，生成前由服务端失败闭合校验。
- 导出请求必须冻结快照、格式、利润率、最低销售成本率和大洲前缀；旧格式产物不得被当前入口复用。工作簿保持数值类型与公式，CSV 保持原始十进制文本、BOM/编码、分片清单与哈希，两者都执行公式注入防护；任何导出都不得包含买家姓名、电话、邮箱或详细地址。

## 5. 前端与交互契约

- 保持 `comfort`、`tech`、`light`、`dark` 四主题及舒适、科技、浅色、深色中文名，默认舒适；首屏恢复不得闪烁，并与账号偏好同步。
- 侧栏保持工作台、销售成本、数据与规则、组织与账号、平台管理五域；平台管理只对管理员显示。企业切换、无企业引导、企业成员协作和公司客户只读关系不得演化成额外平台角色或另一套侧栏。
- 公司工作流只渲染资料准备 `/workflow/commit`、计算复核 `/workflow/calculate`、报告交付 `/workflow/export` 三页；旧 `receive`、`preflight`、`publish`、`upload`、`integrity`、`results`、`exports` 路径只重定向。后台状态、健康状态和进度原位展示，不驱动用户在旧子页面间跳转。
- 页面必须明确区分缺失、排除、软警告、顺延汇率、旧版本、试算和正式快照。结果页保持日期/站点筛选、九张指标卡、缺失站点月份、费用追溯和报告交付，不加入 Sankey 图，也不把不完整结果伪装为正式结果。
- 企业创建者是不可转交的资料负责人；普通有效成员只读企业资料，信用代码仅管理员可修改或补录。做账习惯中的利润率、最低销售成本率可空，五洲前缀默认仅欧洲开启；这些参数只影响本次导出测算和显示，不改写发布快照、内部站点键或历史事实。
- 桌面与窄屏均需可用；表格可以局部横向滚动，页面本身不得无控制溢出。

## 6. 项目验证与生产边界

- 当前统一源码门禁是 `pnpm verify`，实际展开为 `pnpm test`、`pnpm lint`、`pnpm typecheck` 和 `pnpm build`；浏览器契约使用 `pnpm test:e2e`。需要 PostgreSQL 的集成测试必须连接隔离测试库，环境缺失导致的 skip 不能算通过。
- 财务、汇率、导入、权限、支付、队列恢复、大文件、加密和导出变更分别按设计说明书第 17 节的对应矩阵补充或更新测试；上线停止条件以第 18 节为准。
- UI 契约覆盖桌面与窄屏；工作簿变更除结构化测试外，还要在 Excel、WPS 或 LibreOffice 中实际打开并重算；大文件变更需证明续传、行数守恒、ZIP 攻击拒绝、Worker 恢复和内存不随输入线性增长。
- Windows `bin/start.cmd` 仅用于本地开发并使用沙箱 OTP/支付；`ops/` 只是部署示例。正式生产缺少真实短信、支付、ChinaMoney、生产密钥托管、远端对象副本、异机数据库备份或 WAL/PITR 恢复演练时 readiness 必须失败闭合。2026-08-10 批准的固定码受控试运行是唯一例外，必须满足第 7 节的显式开关和边缘保护，readiness 只能报告 `degraded`，不得宣称正式生产就绪。

## 7. Googcci 服务器发布边界

- 服务器当前不能可靠访问 npm Registry；发布制品必须在本地按锁文件准备 Linux x64 生产依赖或离线 pnpm store，并随制品携带固定的 pnpm 9.15.4。服务器安装时显式把 `/opt/revenue-costs/node/bin` 放入 `PATH`，只运行离线、冻结锁文件的生产安装；从 Windows 打包的内容在启用前必须恢复 Linux 可执行位，并确认版本目录不存在组/其他用户可写文件或绝对符号链接。制品只允许包含 `dist/`、`migrations/`、`package.json`、`pnpm-lock.yaml` 和经校验的生产依赖材料，不得包含 `.env*`、测试、`nas/data/`、Git 元数据、数据库转储或本地 `node_modules`。
- 2026-08-11 当前受控试运行版本为 `/opt/revenue-costs/releases/20260811-184953/app`，制品 SHA-256 为 `1ce8a15e128351865741f2464aae7556e2c1022b257038d822ae59167b331e97`，`/opt/revenue-costs/current` 原子指向该目录；Linux 离线依赖安装、API/Worker 启动、48 个迁移的文件名与校验和、数据库备份及公开健康检查均已通过。该版本保留上一版功能，并把常规 PostgreSQL 测试收口到随机 schema 隔离门禁，收口客户 membership 激活/撤权、导出授权绑定与旧令牌失效逻辑，以 API 2、Worker 3、pg-boss 1、发布 CLI 1 的显式连接预算替代无界默认池，并使网络分片上传在持有数据库锁前落入有界 staging；同时修复匿名主题选择在登录后回退、报告参数被延迟默认值覆盖，以及资料准备无法连续追加多个文件夹或文件的问题。生产官方汇率当前为 78,569 条、25 个币种、5,007 个开市日，覆盖 2006-01-04 至 2026-08-10，并保留 2 条当前人工覆盖。生产继续显式启用 `TEMPORARY_PUBLIC_REGISTRATION=true` 和 `PAYMENT_PROVIDER=temporary-manual`；真实注册账号只能获得 `ACCOUNTANT`，管理员授权继续使用应用现有逻辑。
- 公网入口配置在 `/usr/local/nginx/conf/vhost/www.googcci.com.cn.conf`；当前安全头变更的唯一恢复副本为同目录的 `www.googcci.com.cn.conf.pre-revenue-security-20260811-123605`，更早的历史副本已于 2026-08-11 定向清理。当前生效配置不含 `auth_basic` 或 HSTS，Revenue and Costs SPA 返回 CSP、X-Frame-Options、nosniff、Referrer-Policy、Permissions-Policy 和 CORP，资产返回对应类型/引用/权限/资源策略并保留一年缓存。API 请求体上限为 64 MiB、请求缓冲关闭；不得在未再次授权时恢复浏览器账号密码弹窗。健康端点继续只返回粗粒度状态，Nginx 用户 `www` 仅对 `/opt/revenue-costs/releases` 和当前版本父目录持有读取静态制品所需的 execute-only ACL；后续每个新版本启用前必须补齐对应 ACL 并执行 `nginx -t`。
- 当前保留的唯一数据库恢复点为 root-only `/var/backups/revenue-and-costs/pre-release-20260811-184953.dump`；更早的迁移、汇率导入和版本切换恢复点及受控充值前配置副本已于 2026-08-11 定向清理。`DATABASE_CAPACITY_PATH` 当前为 Worker 可访问且与 `pg_wal` 同卷的 `/var/lib/pgsql/17/data`，清理后验证可用空间为 14,434,549,760 字节。服务器无需云控制台即可通过已固定指纹的 SSH 直接管理；UDP 53/123 仍无响应、chrony 未同步，且 PostgreSQL 仍为 `archive_mode=off`、没有异机副本/WAL-PITR；用户已接受试运行期间暂不异地备份，所以 readiness 必须继续返回 `degraded`，不得宣称正式生产就绪。

- 服务器连接元数据保存在被 Git 忽略的 `.env.local`；SSH/SFTP 凭据只从仓库外的既有敏感配置读取，不复制到源码、文档、日志或远端应用环境。连接时必须固定校验 `.env.local` 中的 SSH 主机指纹。
- 2026-08-10 的只读核验事实：服务器为 CentOS 8 x86_64，PostgreSQL 17.10 仅监听 `127.0.0.1:5432`，现有 Googcci 使用 `/opt/googcci/node/bin/node` v22.23.1、`googcci.service`、`127.0.0.1:4182` 和 `/home/wwwroot/www.googcci.com.cn`。这些是另一个项目的资源，不得复用其数据库、服务、运行目录、Node 运行时或应用密钥。
- 2026-08-10 已旁路安装 Revenue and Costs 专属 Node v24.19.0 到 `/opt/revenue-costs/node-v24.19.0-linux-x64`，并以 `/opt/revenue-costs/node` 指向该版本；安装包已按 Node.js 官方 `SHASUMS256.txt` 校验。现有 `/opt/googcci/node` v22.23.1、`googcci.service` 和 `127.0.0.1:4182` 保持不变。
- Revenue and Costs 的其余隔离资源为生产配置目录 `/etc/revenue-and-costs`、回环端口 `4282`、`revenue-costs-api.service`、`revenue-costs-worker.service`、数据库 `revenue_and_costs` 及专属最小权限角色。API 与 Worker 分别加载 root 管理的 `database-app.env` 和其余生产配置 `revenue-costs.env`，不得复制数据库密码。实际名称或路径变化后，应先同步本节和 `.env.local`，再发布。
- 用户已于 2026-08-10 明确接受 `https://www.googcci.com.cn/revenue-costs` 与 Googcci 共享浏览器 Origin 的风险，因此允许按该路径发布；这不构成浏览器安全隔离，任何同源脚本失陷都可能以当前会话访问本应用。数据库、系统账号、服务、端口、运行目录、Node 运行时、应用密钥和 Cookie 名仍必须独立；Cookie 至少使用独立名称、`Secure`、`HttpOnly`、`SameSite` 和受限 `Path`，并保留 Origin/CSRF 校验。若以后需要浏览器级隔离，必须迁移到独立子域名或域名。
- 发布只允许从全新空数据库开始：执行当前前向迁移和内置映射初始化后，只创建用户明确确认的一个管理员账号；禁止复制本地、测试或 Googcci 的账号、企业、公司、钱包、订单、导入、文件、任务和审计数据。启用前必须用数据库查询证明除该管理员及必要系统配置外业务表为空。
- 生产服务必须使用 `NODE_ENV=production`，不得以 development/test 或支付沙箱绕过门禁。用户已于 2026-08-10 明确批准固定码与受控充值试运行：`TEMPORARY_DEGRADED_PRODUCTION=true`、`SMS_PROVIDER=temporary-admin-fixed`、`TEMPORARY_ADMIN_OTP_CODE` 仅从服务器外部敏感配置读取、`PAYMENT_PROVIDER=temporary-manual`、ChinaMoney 关闭、`STORAGE_POLICY=LOCAL_VERIFIED` 且不配置远端副本/备份目标。受控充值不代表微信、支付宝或其他外部支付成功，只允许通过现有幂等订单、签名事件、追加式钱包账本和审计链即时到账；不得称为真实支付。固定码不得由服务端披露；默认只允许 `.env.local` 的初始管理员手机号登录，显式配置 `TEMPORARY_PUBLIC_REGISTRATION=true` 后允许任意手机号注册为 `ACCOUNTANT` 并继续用固定码登录，但 `PHONE_CHANGE_OLD/NEW` 仍失败闭合。管理员授权及最后管理员保护保持现有逻辑；退出临时模式、接入真实短信或宣称正式生产就绪前，必须恢复真实短信、真实支付及异机恢复门禁。
- 每次发布按“本地 `pnpm verify` 与相关 E2E → 服务器新版本目录 → 生产依赖/构建或已验证制品 → 数据库备份与迁移 → 管理员与空库断言 → 原子切换 systemd/Nginx → `/health/live`、粗粒度 `/health/ready` 和关键登录流程验收”推进。保留上一版本目录和数据库恢复点；失败时先撤回公开路由/服务版本，数据库只用前向修复或已演练恢复，不回写迁移历史。
