# 共享 Supabase 项目与独立 Schema 数据库规范

> 版本（本规范自身版本史，非治理版本号，治理版本以 Git 历史为准）：V1.4  
> 日期：2026-09-03  
> 状态：**当前生效**。V1.0～V1.3 保留为历史决策记录，不覆盖、不删除。  
> 适用范围：个人维护的 Web 工具、小网站、Dashboard、桌面工具和内部系统。  
> 核心决定：**一个共享 Supabase 项目；一个工具一个独立 Schema；云端 PostgreSQL 是登录后的唯一主数据源；记录级写入；Auth + Expose + GRANT + RLS 四层访问控制；Realtime 只负责通知，不能替代保存确认或冲突处理。**  
> V1.4 变更摘要：新增 §20「受控扩展点注册」——允许通过平台仓库 Migration 以受控方式注册 Storage bucket、storage.objects 工具桶策略与 publication 表（§2 边界的例外条款），并规定显式 TO 角色、公开桶限额、独立送审与备份收口硬性要求。来源：habit_tracker ENV-1 解冻请求审查（收口审查记录 2026-09-03），经用户批准路径 B 落盘。

---

## 1. 这份规范解决什么问题

本规范让多个个人工具安全共用同一个 Supabase 项目，并让每个新项目有一致的接入、发布、验收、备份和恢复路径。

V1.2 根据 Prompt Manager 的真实接入和 Docker 运行经验，额外明确四个容易误判的事实：

1. 页面刚显示一条数据，不等于它已经写入 Supabase。
2. 收到 Realtime 事件，不等于可以用旧快照覆盖本地正在保存的数据。
3. 只在一台设备使用可以降低跨端竞态风险，但不等于多端同步已经验收通过。
4. Docker 容器只是运行应用；它不是 Supabase 数据库，也不能替代数据库备份或 Migration 管理。完整 Runtime 规则见《Mac Mini 本地项目自托管 Docker 规范》。

V1.3 根据 habit_tracker（两轮审查）与 prompt_manager（收口审查）的真实审查经验，把审查流程中实际使用、但此前未条款化的规则补进正文：审查三态结论与问题输出格式（§16）、可独立复现验证材料的硬性要求（§17）、材料提交位置与转送登记（§18）。新项目接入的填空模板与自查清单见《接入包丨给项目智能体/》（§19 引用）。

新工具接入前必须先读本规范，提出数据库方案并获得确认；未完成前不得自行建表、调整 RLS、改 Dashboard 配置或发布生产 Migration。

## 2. 总体架构与责任边界

```text
共享 Supabase 项目
├── prompt_manager       提示词管理器
├── habit_tracker        个人打卡小工具（示例）
├── other_tool           其他工具
└── platform             仅真正跨工具共享的基础对象

Code     应用源码、Migration、类型、部署模板
Config   .env、Auth URL、publishable key、服务端密钥
Data     Supabase PostgreSQL / Storage、业务数据、备份
Runtime  浏览器、Docker、Mac Mini、VPS、托管平台
```

- 每个工具有一个稳定、小写蛇形的独立 Schema；业务表默认不放 `public`。
- 工具代码必须显式访问自己的 Schema，例如 `supabase.schema('habit_tracker')`。
- 工具 A 不得读写工具 B 的 Schema；跨工具能力必须先评估是否真的属于 `platform`。
- 不修改 `auth`、`storage`、`realtime` 等系统 Schema（受控扩展点注册的例外条款见 §20）。
- Migration 是代码，进入 Git；业务数据、数据库备份、`.env`、原始令牌和用户私有文件不进入 Git。

## 3. 数据源优先级：云端主库与兼容层

### 3.1 运行模式

```text
已登录 + 云端可用
  → 只读写该工具自己的 Supabase Schema

未登录 / 云端不可用 / 正在迁移
  → 仅使用明确标识的本机兼容层或离线草稿
```

登录后的 Supabase 是唯一云端主数据源。本机 `localStorage`、旧 JSON、旧 SSE、旧 `/api/sync` 都只能是过渡兼容层，绝不是第二个可以自动回灌云端的主库。

### 3.2 兼容层硬规则

- 禁止“读出全部数据 → 改一条 → 整份写回”的整库覆盖模式。
- 禁止在云端恢复后自动双向全量合并；导入、恢复或补传必须由用户明确确认。
- 未登录数据必须在界面上明确标为“本机草稿/本机数据”，不能伪装成云端已保存。
- 本机 API Key、令牌、浏览器会话和设备私密偏好不得为了同步方便而写入业务表。
- 旧 JSON 只能作为兼容或独立备份来源；未完成全部验收并经审核批准前，不得删除或停用旧链路。

### 3.3 “已保存到云端”的唯一判定标准

一条新增或修改记录只有同时满足下列条件，才可在产品、QA 或文档中写为“已保存到云端”：

1. 登录态有效，写入请求收到成功确认；
2. 重新从 Supabase 查询或刷新页面后，该记录/修改仍存在；
3. 如果该功能声称多端同步，还须在另一台已登录设备看到相同结果；
4. 若写入有 revision，返回值必须对应预期 revision；返回 0 行或冲突不是成功。

“输入框仍显示”“网格刚出现”“HTTP 200 但未检查返回行数”“收到 Realtime 消息”都不能单独作为保存成功证据。

## 4. 新工具接入固定流程

1. **登记**：说明工具名、独立 Schema、数据敏感度、Auth、Realtime、Storage、离线能力、恢复目标和正式 Runtime。
2. **设计审阅**：列出表、字段、主外键、唯一约束、删除策略、归属字段、RLS、冲突规则、Realtime 表、备份与回滚方案。
3. **共享平台 Migration**：在【平台丨共享 Supabase 数据库】仓库创建 Migration；不得手写时间戳，不得把 Dashboard 当作唯一结构来源。
4. **隔离验证**：核对项目引用、Schema、SQL 影响范围、Expose、GRANT、RLS、Function、备份和恢复方案。
5. **唯一发布**：同一时间只允许一个发布人或一个 CI 流程发布生产数据库。
6. **业务代码接入**：通过 Repository/Service 集中访问该 Schema；浏览器中不散落无边界的 Supabase 查询。
7. **真实验收与审核**：权限、持久化、双设备、冲突、断线、恢复均有记录后，才可申请数据库审核人决定是否收口。

没有完成第 1–2 步的项目，不得直接开始建表或改权限。

接入申请材料按《接入包丨给项目智能体/01_接入申请模板.md》逐项填写（一项不许空），提交前对照《02_自查清单.md》全部打勾；材料提交位置与命名见 §18。

## 5. 数据模型、归属与记录级写入

### 5.1 最低字段基线

业务表通常至少考虑：

```sql
id uuid primary key default gen_random_uuid(),
created_at timestamptz not null default now(),
updated_at timestamptz not null default now(),
revision integer not null default 1
```

有登录数据的表必须有稳定归属字段：

```sql
owner_user_id uuid not null references auth.users(id)
```

多人空间才按需要增加 `workspace_id`。不得用前端传入的用户 ID 或 `user_metadata` 作为授权依据。

### 5.2 建模与写入规则

- 外键、复合唯一约束、`CHECK` 优先于仅靠前端约定。
- 每个外键和高频筛选字段评估索引；不为低数据量盲目建索引。
- 多对多关系使用独立关系表和复合主键/唯一约束，并验证关系两端归属一致。
- JSONB 仅用于不稳定扩展字段；需查询、筛选、排序的核心数据用独立列。
- 新增、更新、删除、关系变更、版本历史、计数分别以单行/原子操作完成；禁止把整个集合作为一次写入单位。
- 更新必须带读取时的 `revision` 或等效并发条件。条件更新返回 0 行即冲突，客户端必须展示冲突并刷新最新记录，不能静默覆盖。
- 版本历史只追加；标签/关系优先“先新增、后删除”，降低中断时短暂丢失全部关系的风险。

## 6. Data API、Auth、GRANT 与 RLS

### 6.1 自定义 Schema 四道门

浏览器访问自定义 Schema 时，必须逐项核实：

1. **Expose**：该 Schema 已列入 Supabase Data API 的 Exposed schemas。
2. **GRANT**：所需角色对 Schema、表、序列、函数拥有最小对象权限。
3. **RLS**：每张暴露表启用 RLS。
4. **Policy**：每一种 `SELECT`、`INSERT`、`UPDATE`、`DELETE` 都按实际归属限定行。

新表不会始终自动暴露给 Data API；Expose、GRANT 和 RLS 是不同层，任何一层缺失或错误都必须被视为接入未完成。

### 6.2 私有数据固定 RLS 模式

```sql
-- SELECT：只能读自己的行
using ((select auth.uid()) = owner_user_id)

-- INSERT：只能创建归属自己的行
with check ((select auth.uid()) = owner_user_id)

-- UPDATE：旧行与新行归属都不能越权
using ((select auth.uid()) = owner_user_id)
with check ((select auth.uid()) = owner_user_id)
```

- `UPDATE` 需要对应 `SELECT` Policy；否则可能无报错地更新 0 行。
- 不得只写 `TO authenticated`；它只说明已登录，不说明拥有目标行。
- 不得允许 UPDATE 改写 `owner_user_id`。
- 每个接入必须实测未登录、另一用户、伪造 owner、越权更新/删除均失败。

### 6.3 Auth 是共享项目全局能力

OAuth Provider、Magic Link、Site URL、Redirect URL、邮件、SMTP、会话策略会影响共享项目内所有接入工具。

- 新工具先复用既有 Auth，再提出全局配置变更。
- 改 URL 前列出所有受影响工具的本地、LAN、正式地址和回调地址。
- 运行地址应由项目 Runtime 配置管理；不要把某个项目的 LAN IP 当成其他项目的默认地址。
- 登录问题先检查 Site URL、Redirect URL、浏览器会话和 Auth 日志，再修改业务代码。

## 7. 密钥、MCP 与高权限 Function

### 7.1 环境变量边界

浏览器只可使用公开配置：

```text
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
```

以下绝不进入浏览器包、Git、日志、截图、文档示例或聊天：

```text
service_role / secret key
数据库密码与带密码连接串
用户 AI API Key
MCP 原始令牌
```

`NEXT_PUBLIC_*` 会被构建进前端；即使在 Docker 的 `.env.local` 中，它们也只能是公开 URL 与 publishable key。

### 7.2 MCP 设备能力令牌

- 每台设备一枚独立、随机、可撤销令牌；数据库仅保存哈希。
- 原始令牌只在创建时显示一次，只写入该设备本地私密 `.env.local`。
- 令牌管理只能显示设备名、创建时间、最后使用、撤销状态，不回显令牌。
- MCP 不读取其他设备 JSON，不使用 `service_role`，不持有数据库密码。
- 调取和计数等有副作用动作必须由受限数据库 Function 原子完成。
- 每台设备必须分别完成真实调取；撤销其中一枚后，另一枚仍可使用，才可称“设备令牌隔离已验证”。

### 7.3 `SECURITY DEFINER` 例外

默认使用 `SECURITY INVOKER`。只有普通 RLS 无法满足、且有明确最小权限设计时才允许 `SECURITY DEFINER`。

- Function 放在工具自己的 Schema，不放 `public`；固定收紧 `search_path`，对象使用明确 Schema。
- 不用动态 SQL；校验输入长度、格式、归属与撤销状态；只返回必要字段。
- 撤销默认 `PUBLIC` 执行权，只授予实际角色；若必须允许匿名能力令牌调用，必须记录高熵令牌、撤销、审计、限流和安全顾问结论。
- 发布前实测成功、未授权、撤销后、跨用户和并发副作用路径。

安全顾问告警不能被“忽略”；必须写明风险、限制、责任人和下一次复查条件。

## 8. Migration、发布、紧急修复与审核

```text
设计审阅
  → 共享平台仓库创建 Migration
  → SQL / RLS / Function 审查
  → 隔离环境验证
  → 备份确认
  → 唯一发布人发布
  → migration 状态、RLS、功能、Advisors 复核
  → 数据库审核人决定是否收口
```

- 共享平台仓库是 Schema、表、约束、索引、RLS、Policy、Function、Trigger、Realtime publication 和 Migration 的唯一权威来源。
- 业务项目不得维护第二套同一项目的 Migration 历史；业务仓库只维护 Repository/Service、类型、UI 和测试。
- 发布前必须确认正确 Supabase 项目、目标 Schema、Migration 顺序、影响范围、备份和可执行恢复方法。
- 接入智能体不是数据库审核人：不得自行宣告收口、发布待审 Migration、执行未经批准的 `supabase db push` 或修改 Dashboard。

### 紧急生产修复

生产紧急 SQL 仅是例外。发生后必须记录实际 SQL、时间、项目、Schema、原因和副作用；再把**完全一致**的内容回写到共享平台 Migration，在隔离环境重放并复核。生产与 Git 未重新一致前，暂停该 Schema 的后续发布。

禁止多个 Agent/设备并发发布、未核对项目/Schema 的 SQL、未备份的破坏性 SQL、将生产数据写入 `seed.sql`，以及只改 Dashboard 而不回写 Migration。

## 9. Realtime、写入队列与并发

### 9.1 Realtime 的职责

Realtime 是“数据库发生变化”的通知；不是保存确认、事务日志、自动冲突合并或可靠历史回放。每个工具必须：

- 明确把所需表加入 `supabase_realtime` publication；订阅自己的 Schema、表和事件。
- 初始加载主动查询；断线重连后主动补读。
- 在本机写入队列有未确认变更时，不用 Realtime 回读的旧集合覆盖本地 state。
- 订阅回调必须考虑：本机乐观更新、尚未送达的写入、写入失败、重复事件和重新订阅。
- 验证 RLS 只让合法用户收到自己的事件，不泄露其他用户数据。

### 9.2 写入可靠性最低要求

任何支持“保存”的前端都必须具备：

1. 记录级写入队列或等效串行化；
2. 写入成功/失败的明确状态，失败不能静默丢弃；
3. 保存成功后才允许把对应本机变更标记为已同步；
4. Realtime 回读仅在没有未确认本机变更时替换全量集合；
5. 用户可通过刷新重新读取云端，验证重要数据仍存在；
6. 多端宣称前完成真实双设备 CRUD、断线、冲突验收。

### 9.3 单设备运行模式

用户临时只在一台设备使用时，可以作为降低跨设备写入竞态的运行策略，但必须同时满足：

- 该设备使用登录后的云端模式，而不是本机未登录抽屉；
- 不把另一台设备、旧客户端或脚本连接到同一工具；
- 重要新增后允许用户刷新确认，并按计划导出备份；
- 文档状态写为“单设备运行”，不能改写为“多端同步已验证”或“数据库收口”。

## 10. Runtime 交界与 Docker 规范引用

数据库规范只规定 Runtime 不得破坏数据与权限边界：Docker 容器不是 Supabase 数据库；运行时验证不能替代数据持久化、RLS、多端或恢复验收；公开 URL/端口变更须评估 Auth 回调影响。

目录、Compose、环境变量、bind mount、Named Volume、升级回滚、备份与云厂商迁移，以《Mac Mini 本地项目自托管 Docker 规范》为唯一权威来源。数据库结构、Migration、RLS、Function 和审核门禁仍只由本文件管理。

## 11. 验收、备份与发布门禁

### 11.1 验收层级

| 层级 | 最低证据 | 不代表什么 |
|---|---|---|
| L0 代码/构建 | 类型检查、Lint、构建通过 | 真实浏览器、云端写入通过 |
| L1 登录与读 | 已登录、能读取自己的云端数据 | 新增/修改已持久化 |
| L2 单设备持久化 | 写入成功后刷新仍存在 | 多端、并发、恢复通过 |
| L3 多设备 CRUD | 两台已登录设备互见新增、编辑、删除、关系与计数 | 冲突和恢复通过 |
| L4 并发与故障 | 冲突明确、断网重连补读正确、无静默丢失 | 备份恢复通过 |
| L5 恢复与审核 | 隔离恢复演练、Migration/Advisors 复核、完整材料交审核人 | 审核人已批准发布 |

每份 QA 记录必须标明实际设备、时间、操作和结果。HTTP 200、单机页面、静态检查、页面即时渲染都不能冒充 L2–L5。

### 11.2 最低清单

- [ ] Schema、Migration、约束、索引和回滚方案可追溯。
- [ ] Expose、GRANT、RLS、Policy 四道门均已验证。
- [ ] 未登录、其他用户、伪造归属、越权 CRUD 全部被拒绝。
- [ ] 单设备写入后刷新仍在；错误状态不会静默丢失。
- [ ] 多设备 CRUD、关系、版本历史、原子计数、并发冲突、断网重连已实测。
- [ ] MCP 每设备令牌、撤销隔离和 Function 越权路径已实测（若适用）。
- [ ] 数据库结构与数据已备份；恢复步骤在隔离环境演练；备份至少有另一位置副本且不进 Git。
- [ ] 旧兼容链路的保留/下线决定、数据迁移和回退路径已由审核人批准。

## 12. 当前项目基线（prompt_manager/habit_tracker 实例，随项目替换；事实，不等于收口）

> 2026-09-03 更新。本节只保留稳定的结构事实（Schema、Expose、结论、遗留边界）；Migration 数、策略角色、行数等高频易变数据**一律不写进表格**，以 AGENTS.md §五「当前状态快照」与平台 README「接入状态 / 机器可校验命令」块为准（两处均标注校验时点）。

| 项目 | 当前状态 | 边界 |
|---|---|---|
| Schema 与主库 | `prompt_manager`、`habit_tracker` 两个独立 Schema，登录后使用共享 Supabase 项目 | 不使用 `public` 保存业务数据 |
| 认证与读 | Air、Mini 已 Google 登录；Mini 登录态可读取云端数据 | 页面可读不自动证明每次新增都已落云 |
| 记录级能力 | 已有 cards、versions、tags、关系、settings、MCP 令牌等云端数据与 RLS/Realtime 接入 | 保留旧 JSON/API/SSE 兼容链路 |
| Docker Runtime | Mac Mini 正式容器运行中，Supabase 仍为云端主库 | 容器正常不等于多端验收或收口 |
| 当前运行策略 | 用户选择只在 Mac Mini 的已登录云端页面使用 | 这是单设备风险控制，不是多端验收通过 |
| 备份恢复 | Supabase 结构/数据导出与隔离恢复演练已完成 | 备份不进 Git，仍需按计划定期复核 |
| BUG-11 | 暂缓：新卡在跨端回读时可能被旧快照覆盖的现象尚未完成真机复验 | 单设备使用可降低风险；不能把它标为已修复或以此申请收口 |
| Migration | 两项目 Migration 全部已发布、Local=Remote 对齐（2026-09-03）；prompt_manager 治理侧收口归档、habit_tracker S1/S2 均已完成——发布细节与复核证据见 AGENTS.md §五、平台 README 与 `docs/reviews/` | 仅共享 Supabase 数据库审核人可决定后续发布 |
| 收口观察项 | PM-1 已解决（单仓库收编 + 私有 remote）；PM-2（材料回填）/PM-3（写队列，P1）/PM-4（连字符调取码）为应用侧遗留，已转项目方 | 详见 `项目审查丨prompt_manager/转送文件清单丨prompt_manager.md` |
| habit_tracker | 2026-09-03 获 APPROVED_FOR_EXECUTION（V1.1 方案，审查方全新 PG16 独立复现全通过）；S1、S2 与平台级策略统一变更均已落地 | 0002（Storage/Realtime）与任何范围扩大仍冻结 |

## 13. 给 AI 的固定接入提示

> **新项目智能体从《接入包丨给项目智能体/00_接入指引.md》开始**（流程、红线、申请模板、自查清单、典型问题案例）；本节是技术底线的浓缩版。
>
> 本工具接入共享 Supabase 项目，必须创建并仅使用独立的 `<tool_schema>` Schema。先说明 Schema、表、归属字段、RLS、Data API Expose/GRANT、Realtime、写入确认、冲突处理、备份、恢复与 Docker Runtime 交界，待确认后再写 Migration。结构、Policy、Function、Trigger、publication 和 Migration 只能由【平台丨共享 Supabase 数据库】仓库管理。禁止使用其他工具 Schema、禁止业务表放 `public`、禁止整库 JSON 覆盖、禁止浏览器暴露 secret/service role、禁止用 user_metadata 授权。Realtime 只能通知变化，不能在本机有未确认写入时覆盖本地状态。页面即时显示不等于云端保存；须经成功回执与刷新后重读确认。完成后必须验证越权 RLS、单设备持久化、双设备 CRUD、并发冲突、断线重连、备份恢复和审核交接；Docker 部署细节另按《Mac Mini 本地项目自托管 Docker 规范》执行。

实施前，AI 必须回答：

1. Schema 是什么，为什么不与现有工具混用？
2. 表、关联、约束、索引、归属字段和删除策略是什么？
3. 哪些对象需要 Expose、哪些角色需何种 GRANT、每种 CRUD 的 RLS 如何限制？
4. 写入何时才算“已保存到云端”？本机写队列与 Realtime 回读怎样避免丢失？
5. Auth、Redirect URL、邮件、Runtime 地址会影响哪些现有工具？
6. 同一记录并发编辑、关系变化、离线与重连如何处理？
7. Migration 在哪里创建、谁发布、如何验证、备份和恢复？
8. Docker 的开发目录、部署目录、持久化数据、备份目录和密钥边界是什么？
9. 是否需要 MCP、Function 或 Storage；若需要，为什么普通 RLS 不足，以及如何撤销和验收？

## 14. V1.2 相对 V1.1 的更新摘要

- 把“页面显示不等于已保存”写为可执行的 L2 持久化验收标准。
- 把 Realtime 的通知职责、写入队列、未确认变更保护与旧快照覆盖风险列为硬性实现要求。
- 新增单设备运行模式：它是风险控制措施，不是多端验收或数据库收口替代品。
- 将 Docker Runtime 的目录、Compose、环境变量、持久化、备份和云厂商迁移细则拆分至独立《Mac Mini 本地项目自托管 Docker 规范》；本文件只保留数据库与 Runtime 的交界。
- 将验收拆为 L0–L5，禁止把构建、HTTP 200 或页面即时显示冒充云端持久化/多端验收。
- 记录 Prompt Manager 的已验证基线、暂缓 BUG、待审 Migration 与审核人门禁，避免后续智能体误判“已收口”。

## 15. 官方参考

- [Supabase Securing your API](https://supabase.com/docs/guides/api/securing-your-api)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase Custom Schemas](https://supabase.com/docs/guides/api/using-custom-schemas)
- [Supabase Database Functions](https://supabase.com/docs/guides/database/functions)
- [Supabase Database Migrations](https://supabase.com/docs/guides/deployment/database-migrations)
- [Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Supabase Changelog](https://supabase.com/changelog)

## 16. 审查结论与问题输出格式

> 本节把 2026-09-03 两次审查（habit_tracker、prompt_manager）中实际执行的审查规则条款化；数据库管理员与项目智能体均以此为准，避免执行走样。

### 16.1 三态结论

审查结论只允许三种，含义与边界如下：

| 结论 | 含义 | 明确不包括 |
|---|---|---|
| `APPROVED_FOR_EXECUTION` | 当前方案和当前阶段的证据满足要求，可进入审核意见明确允许的下一阶段 | 不包括扩大 Schema、表、字段、Function、Policy、Storage、Realtime 或数据范围；不自动等于生产发布完成 |
| `CHANGES_REQUIRED` | 总体方向可以，但存在明确可修复问题；修复并重新审核前不得执行生产变更 | 不包括「先批准后补材料」 |
| `BLOCKED` | 存在无法确认的关键事实或不可接受的风险（目标项目无法确认、Migration 来源不明、无备份、无隔离验证、权限边界不清、生产状态无法核对、高权限 Function 无控制措施） | 阻塞解除前不得继续扩大权限或执行数据库操作 |

### 16.2 问题输出格式

审查发现的每个问题必须按以下格式输出，禁止只写「看起来没问题」「总体可行」「后续注意权限」「可以先上线再验证」：

```text
问题编号：
严重级别：阻断 / 高 / 中 / 低
文件路径：
行号或数据库对象：
当前现象：
风险说明：
具体修改要求：
修改后的验收标准：
当前状态：已验证 / 待验证 / 存在问题
```

### 16.3 审查纪律

- 每个新问题按收到顺序编号（如 R2-1、R2-2），便于增量复审追踪。
- 增量复审只核对新增材料与已声明的修复项，不重走全量。
- 审查结论属于管理员例行职责，直接写入权威记录（方案 §审查记录、送审清单、转送清单）并给用户绝对路径，无需逐次请求确认。
- 「把未验证、推测或代码可见内容写成已通过」视同 BLOCKED 级违规。
- 审查方可随时用全新 PostgreSQL 独立复现项目方提交的验证脚本（见 §17）；复现结果与提交结果不一致时，按存在虚假证据处理。

## 17. 可独立复现验证材料（硬性要求）

> 来源：R2-1 教训——项目方交了全 PASS 的结果文件，但脚本依赖的桩文件未提交、加载顺序错误、隔离环境已删除，证据实际不可复现。

申请材料中的验证证据必须满足以下全部条件，缺任何一条按材料不完整处理：

1. **三件套齐全**：验证脚本 + 全部依赖桩文件（auth 角色桩、auth.users 桩等）+ 结果文件。只有结果文件等于没有证据。
2. **加载顺序正确**：桩文件必须先于 Migration 加载。
3. **复现命令写明**：脚本头部注释给出从零复现的完整命令（例如 Docker `postgres:16` + 端口 + 执行顺序），审查方将亲自重跑。
4. **验收标准**：审查方仅凭提交的材料 + 全新 PostgreSQL 16 即可复现提交结果。审查方独立复现通过后，该项证据才算「已验证」。
5. **用例名称与被测行为一致**：每条关键保护路径（跨用户越权、幂等重放、条件更新冲突、白名单拒绝）都要有「真正命中」的用例；测试引用的行必须真实存在。
6. **环境销毁不影响证据效力**：隔离环境可临时，但材料必须自包含。

## 18. 材料提交位置、命名与转送登记

> 来源：两次审查中材料位置漂移（业务项目 docs/、review/ 各放各的）、收口材料状态声明过时的教训。

1. **唯一提交位置**：所有接入方案、审查材料、Migration 草案、验证证据统一放入 `/Users/zzymima0000/Developer/coding/1.Active/alw丨数据库管理专家/项目审查丨<项目名>/`（示例路径，各项目替换为自家管理仓）。业务项目仓库不得作为数据库治理材料的存放地。
2. **Migration 草案命名**：业务项目内只保留草案（如 `0001_init.sql`），文件头标注版本与「草案」字样；正式 Migration 由【平台丨共享 Supabase 数据库】仓库按时间戳命名管理。
3. **提交前刷新声明**：收口/复审材料中的状态声明（git commit、SHA、link 状态、文件大小）必须以提交时刻的实际状态为准；材料与事实不一致本身就是问题。
4. **转送登记**：凡需用户在智能体之间人工转送的文件，必须登记到 `项目审查丨<项目名>/转送文件清单丨<项目名>.md` 并附绝对路径，再由用户转送。
5. **审查产出归档**：管理员结论写入方案文档的审查记录章节 + 送审清单 + 转送清单三处，保持一致。

## 19. 接入包与 V1.3 相对 V1.2 的更新摘要

### 19.1 接入包

新项目接入的唯一起点是接入包（位于 `alw丨数据库管理专家/接入包丨给项目智能体/`）：

| 文件 | 用途 |
|---|---|
| `00_接入指引.md` | 一页纸流程（5 步）、三态结论、红线、转送约定 |
| `01_接入申请模板.md` | 25 项填空模板，逐项必填 |
| `02_自查清单.md` | A–E 五组提交前预检 |
| `03_典型问题案例.md` | 历次审查沉淀的 15 个真实反例（C-1～C-15） |

给新项目智能体时，只需提供 `00_接入指引.md` 的绝对路径。

### 19.2 V1.3 更新摘要

- 把审查三态结论（`APPROVED_FOR_EXECUTION` / `CHANGES_REQUIRED` / `BLOCKED`）的定义、边界与禁止表述条款化（§16.1）。
- 把审查问题输出格式（严重级别 + 八字段）固化为正式标准（§16.2），并补充审查纪律：问题编号、增量复审、免确认写入、独立复现权（§16.3）。
- 新增「可独立复现验证材料」硬性要求：三件套、加载顺序、复现命令、验收标准与用例一致性（§17）。
- 新增材料提交位置、草案命名、提交前刷新声明、转送登记条款（§18）。
- 接入包（申请模板 + 自查清单 + 典型案例）正式纳入规范引用（§19.1）。
- 刷新 §12 项目基线：prompt_manager 收口放行 + 20260901163555 批准发布；habit_tracker 获 APPROVED_FOR_EXECUTION（当日 S1 发布与 S2 Expose 核对、平台级策略统一 Migration 均相继完成；后续时效状态以 AGENTS.md §五 权威快照为准）。
- 本节更新全部来自 habit_tracker（两轮）与 prompt_manager（收口）审查的真实发现，无新增技术要求，只把已验证有效的做法落成文字。

---

## 20. 受控扩展点注册（Storage / Publication）

在共享项目中，下列动作**不视为「修改系统 Schema」**（§2 例外），允许通过平台仓库 Migration 以「受控注册」方式执行，但必须同时满足本节全部约束：

| 扩展点 | 允许的动作 | 禁止的动作 |
|---|---|---|
| `storage.buckets` | INSERT `id`/`name` 以工具名为前缀的桶（`<tool>-*`），可设置 `public` / `file_size_limit` / `allowed_mime_types` | UPDATE/DELETE 既有非本工具桶；注册与工具前缀不符的桶名 |
| `storage.objects` | 创建 `bucket_id` 限定为本工具桶的 RLS 策略 | 未显式声明 TO 角色（默认 PUBLIC）；影响其他桶的策略 |
| `supabase_realtime` publication | ADD TABLE 本工具 Schema 内的表 | REMOVE/DROP 既有成员；添加他工具或系统表 |

硬性要求：

1. 每类动作独立 Migration、单独送审，附 PG16 隔离验证与断言；
2. 策略必须显式声明 TO 角色，anon 能力仅限设计内显式授权并写入方案；
3. 公开桶必须设置 `file_size_limit` 与 `allowed_mime_types`；
4. 执行前备份 `storage.buckets` / `storage.objects` 既有策略 / publication 成员现状，执行后管理员线上收口核验；
5. Realtime 注册仍受 §9 约束，不得替代保存确认。

---

## 21. V1.4 相对 V1.3 的更新摘要

- 新增 §20「受控扩展点注册」：把 Storage bucket 注册、工具桶 RLS 策略、publication ADD TABLE 定义为 §2「不修改系统 Schema」的例外（受控注册），并规定显式 TO 角色、公开桶限额、独立 Migration 送审、执行前备份与执行后收口五项硬性要求（§20.1–§20.5）。
- 来源：habit_tracker ENV-1 解冻请求（0002 Storage 部分）审查发现——pending 草案技术形态正确但与 V1.3 §2 边界冲突，且策略默认 PUBLIC 与 P1-1 收口口径冲突。经收口审查裁定 CHANGES_REQUIRED + 用户批准路径 B 后落成本条款，未来所有接入工具统一适用。
- 时效状态（Migration 数、项目收口进度等）以 AGENTS.md §五 权威快照为准，本规范不承载易变数值。
