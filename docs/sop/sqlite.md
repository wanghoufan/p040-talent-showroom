# Mac Mini 本地 SQLite 数据库规范

> 版本（本规范自身版本史，非治理版本号，治理版本以 Git 历史为准）：V1.0  
> 日期：2026-09-15  
> 状态：当前建议基线。适用于个人维护的本地 Web 工具、Dashboard、桌面工具、内部系统等使用 SQLite 作为主数据库或本地数据库的项目。  
> 配套规范：
> - 《Mac Mini 本地项目自托管 Docker 规范》
> - 《共享 Supabase 项目与独立 Schema 数据库规范》
>
> 核心决定：**一个项目一个独立 SQLite 数据库文件；数据库运行文件放入 `DockerData/<project_slug>/db/`；数据库备份放入 `DockerBackups/<project_slug>/sqlite/`；SQLite 属于嵌入式文件数据库，可作为 Docker 规范中“本地数据库使用 Named Volume”规则的明确例外，但仅限 SQLite，不扩展到 PostgreSQL / MySQL 等独立数据库服务。**

---

## 1. 目标与适用范围

本规范解决以下问题：

- 本地项目使用 SQLite 时，数据库文件应该放在哪里；
- 多个项目如何隔离；
- Docker 容器如何挂载 SQLite；
- 数据库结构如何版本化；
- 如何备份、恢复、迁移；
- 如何避免把真实数据库误提交到 Git；
- 后续 AI / 开发者接入 SQLite 时遵守统一规则。

适用于：

- 单用户或少量用户；
- 写入并发较低；
- 运行在 Mac Mini / NAS / VPS / 单机 Docker；
- 数据量较小到中等；
- 不需要 Supabase Auth / RLS / Realtime 等云数据库能力的工具。

不建议直接使用 SQLite 的典型场景：

- 高并发写入；
- 多实例同时写同一个数据库；
- 多租户复杂权限；
- 大量跨设备实时协作；
- 明确依赖 PostgreSQL 特性的业务。

---

## 2. 与现有 Docker / Supabase 规范的关系

### 2.1 Docker 规范仍是 Runtime 权威规范

开发源码、正式部署副本、DockerData、DockerBackups 的职责仍按《Mac Mini 本地项目自托管 Docker 规范》执行。

SQLite 仅新增一个明确例外：

> PostgreSQL / MySQL 等独立数据库服务的数据目录仍必须使用 Docker Named Volume。  
> **SQLite 因为是应用进程直接读写的嵌入式数据库文件，允许通过 bind mount 保存在 `DockerData/<project_slug>/db/`。**

此例外不得被扩展解释为：
- PostgreSQL 数据目录可放 DockerData；
- MySQL 数据目录可放 DockerData；
- 任意数据库都可直接 bind mount 到业务目录。

### 2.2 Supabase 与 SQLite 是两种不同架构

Supabase 项目继续遵守：

> 一个共享 Supabase 项目 + 一个工具一个独立 Schema。

SQLite 项目遵守：

> **一个工具 / 一个项目 = 一个独立 SQLite `.db` 文件。**

不要把多个无关项目的数据表塞入同一个 SQLite 数据库。

---

## 3. 项目标识与标准目录

每个项目必须有稳定的 `project_slug`，使用英文小写短横线，例如：

```text
dividend-portfolio
personal-checkin
local-dashboard
```

标准目录：

```text
/Users/zzymima0000/
├── Developer/coding/1.Active/<项目目录>/          # 唯一开发源码
├── Developer/coding/docker/<project_slug>/        # 正式部署副本
├── DockerData/<project_slug>/                     # 正式运行数据
│   └── db/
│       └── <project_slug>.db                      # SQLite 主数据库
└── DockerBackups/<project_slug>/                  # 正式备份
    └── sqlite/
        ├── daily/
        ├── pre-deploy/
        └── restore-tests/
```

示例：

```text
/Users/zzymima0000/DockerData/dividend-portfolio/db/dividend-portfolio.db
```

数据库文件名必须与 `project_slug` 一致，避免出现：

```text
data.db
database.db
app.db
test.db
```

这种无法识别归属的泛化文件名。

---

## 4. 多项目隔离规则

固定原则：

> **一个项目一个数据库文件。**

正确：

```text
DockerData/
├── dividend-portfolio/
│   └── db/dividend-portfolio.db
├── personal-checkin/
│   └── db/personal-checkin.db
└── local-dashboard/
    └── db/local-dashboard.db
```

禁止：

```text
DockerData/shared-db/all-projects.db
```

再在里面建立：

```text
dividend_*
checkin_*
dashboard_*
```

原因：

- 备份无法独立；
- 恢复会牵连其他项目；
- 项目迁移不独立；
- Schema 演进互相污染；
- AI / 开发者容易误操作其他项目数据。

SQLite 不使用 Supabase 那种“一个库多个 Schema”的治理模式。

---

## 5. 开发数据库与生产数据库分离

开发环境不得直接使用正式数据库文件。

建议：

```text
<开发源码>/
├── db/
│   ├── migrations/
│   ├── schema.sql
│   └── seed.example.sql
└── var/
    └── dev.db
```

其中：

- `db/migrations/`：数据库结构变更脚本，进入 Git；
- `schema.sql`：当前结构快照，可进入 Git；
- `seed.example.sql`：只允许示例 / 脱敏数据；
- `var/dev.db`：开发数据库，必须加入 `.gitignore`；
- 正式数据库只存在 `DockerData/<project_slug>/db/`。

严禁：

- 把生产 `.db` 拷贝进 Git 仓库；
- 使用真实生产数据库做开发测试；
- 把真实投资、个人记录、用户数据写入 seed 文件。

---

## 6. Docker 挂载规则

正式容器通过 bind mount 访问 SQLite：

```yaml
services:
  app:
    volumes:
      - ${APP_DATA_DIR}/db:/app/data/db
```

应用内部统一使用容器路径，例如：

```text
/app/data/db/<project_slug>.db
```

宿主机路径由环境变量提供：

```text
PROJECT_SLUG=dividend-portfolio
APP_DATA_DIR=/Users/zzymima0000/DockerData/dividend-portfolio
APP_BACKUP_DIR=/Users/zzymima0000/DockerBackups/dividend-portfolio
SQLITE_DB_PATH=/app/data/db/dividend-portfolio.db
```

业务代码不得写死：

```text
/Users/zzymima0000/...
```

宿主机目录必须事先明确创建，Compose 不得静默创造未知生产目录。

---

## 7. 数据库结构与 Migration

SQLite 虽然简单，但正式项目仍必须有 Migration。

推荐源码结构：

```text
db/
├── migrations/
│   ├── 0001_init.sql
│   ├── 0002_add_transactions.sql
│   └── 0003_add_portfolio_cycles.sql
└── schema.sql
```

规则：

1. 已发布 Migration 不回改；
2. 新结构使用新 Migration；
3. Migration 进入 Git；
4. 真实 `.db` 不进入 Git；
5. 生产升级前必须备份；
6. Migration 失败不得继续启动写业务数据；
7. 数据库结构版本需记录在数据库内部，例如 `schema_migrations` 或框架自带版本表。

禁止长期依赖散落在应用启动代码中的 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` 作为唯一结构治理方式。

---

## 8. SQLite 推荐运行设置

正式项目应评估并通常启用：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

说明：

- `foreign_keys=ON`：让外键真正生效；
- `WAL`：改善读写并发与崩溃恢复体验；
- `busy_timeout`：短暂写锁时避免立即失败。

具体值允许按项目调整，但必须记录原因。

注意：SQLite 仍然是“单写者”架构，不应因为开启 WAL 就把它当成 PostgreSQL 使用。

---

## 9. 数据访问规则

业务代码应通过集中 Repository / Service 访问数据库，例如：

```text
src/
└── repositories/
    ├── portfolio_repository.py
    ├── transaction_repository.py
    └── cycle_repository.py
```

禁止：

- 页面组件到处直接写 SQL；
- 多个模块各自创建不同数据库路径；
- 同一个项目同时存在多个“主库”；
- 浏览器直接访问 `.db` 文件。

浏览器访问路径应始终是：

```text
浏览器
  → 应用 HTTP API / Server
  → SQLite
```

---

## 10. 数据变更与审计思路

重要业务建议使用“事件 / 记录追加”而不是只维护最终状态。

例如投资类工具，不要只保存：

```text
格力电器 = 300 股
```

应保存：

```text
首次建仓 +100
追加投资 +100
再平衡 +100
清仓 -300
```

当前持仓通过交易记录累计或由受控汇总表得出。

适合此模式的数据包括：

- 投资批次；
- 交易确认；
- 建仓；
- 追加；
- 再平衡；
- 清仓；
- 状态变化；
- 用户确认动作。

---

## 11. 备份规则

SQLite 的优势之一是数据库主要表现为单个文件，但运行中不能简单把“复制正在写入的 db 文件”当作可靠备份。

正式备份优先使用 SQLite 自身备份能力，例如：

```bash
sqlite3 /path/app.db ".backup '/path/backup/app-YYYYMMDD-HHMMSS.db'"
```

或：

```bash
sqlite3 /path/app.db "VACUUM INTO '/path/backup/app-YYYYMMDD-HHMMSS.db';"
```

备份目录：

```text
DockerBackups/<project_slug>/sqlite/
```

建议至少包含：

```text
daily/
pre-deploy/
restore-tests/
```

备份命名：

```text
2026-09-15_030000_dividend-portfolio.db
```

最低规则：

- 每日自动备份；
- 每次正式部署 / Migration 前额外备份；
- 至少保留一个异地副本；
- 备份不进 Git；
- 不在 Docker 容器可写层中保存唯一备份。

---

## 12. 恢复规则

恢复必须先在隔离环境验证。

标准流程：

```text
选择备份
→ 复制到隔离目录
→ 启动隔离容器 / 测试应用
→ SQLite integrity_check
→ 检查 schema version
→ 检查关键表行数
→ 执行关键业务读取
→ 确认无误
→ 用户批准
→ 才允许替换生产数据库
```

最低检查：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

禁止：

- 生产库损坏后直接覆盖；
- 未验证备份就替换生产；
- 恢复时删除全部历史备份；
- 用开发数据库覆盖生产。

---

## 13. 图形化管理与 CLI

SQLite 本身不要求安装数据库服务器。

应用可通过语言内置驱动直接访问，例如 Python 标准库：

```python
import sqlite3
```

人工查看可以使用：

- DB Browser for SQLite；
- DBeaver；
- TablePlus；
- `sqlite3` CLI。

图形化工具主要用于查看表、查询数据、故障排查、验证 Migration、检查备份。正常业务操作仍应通过正式网页 / 应用完成，不鼓励日常手工改生产数据库。

---

## 14. 安全边界

SQLite 文件本身就是核心数据资产。

因此：

- 不提交 Git；
- 不放公网静态目录；
- 不通过 Web Server 直接暴露；
- Docker 只给应用容器挂载；
- 文件系统权限限制到必要用户；
- 不把密钥、Token 与业务数据混进同一表“图方便”；
- 导出文件如含敏感数据，同样进入 DockerData / DockerBackups 管理体系。

若未来产品需要多用户强权限隔离、行级权限、Auth、公网多人访问，应重新评估是否迁移 Supabase / PostgreSQL，而不是继续给 SQLite 叠复杂权限系统。

---

## 15. SQLite 与 Supabase / PostgreSQL 的升级边界

以下情况出现时，应评估迁移：

- 高并发写入明显增加；
- 需要多应用实例；
- 多用户账号体系；
- 行级访问控制；
- Realtime；
- 服务端函数；
- 大量跨设备并发编辑；
- 云端高可用要求。

迁移时：

```text
SQLite
→ 导出结构与数据
→ 映射到 PostgreSQL Schema
→ 创建正式 Migration
→ 导入
→ 完整数据核对
→ 双读 / 灰度验证
→ 切换主库
→ 保留 SQLite 只读归档一段时间
```

不得直接把 `.db` 文件“上传到 Supabase”当作迁移。

---

## 16. 给项目智能体的固定 SQLite 接入提示

> 本项目如采用 SQLite，必须遵守《Mac Mini 本地 SQLite 数据库规范》和《Mac Mini 本地项目自托管 Docker 规范》。先确认 `project_slug`、开发源码目录、正式部署副本、`DockerData/<project_slug>/db/`、`DockerBackups/<project_slug>/sqlite/`、SQLite 文件名、Migration 目录、备份与恢复方案，再实施数据库接入。一个项目只能有一个主 SQLite 数据库文件，不得与其他项目共库。正式 `.db` 不进入 Git，结构 Migration 必须进入 Git。SQLite 正式库允许作为嵌入式数据库例外通过 bind mount 放在 DockerData；PostgreSQL / MySQL 等独立数据库仍必须遵守 Named Volume 规则。完成后必须验证 Migration、外键、WAL、持久化、备份、隔离恢复和容器重建后数据仍存在。

实施前必须回答：

1. `project_slug` 和数据库文件名是什么？
2. 正式数据库绝对路径是什么？
3. 开发库与生产库如何隔离？
4. Migration 放在哪里、如何版本化？
5. Docker 如何 bind mount？
6. 备份频率和备份路径是什么？
7. 如何执行 `integrity_check` 与恢复演练？
8. 为什么本项目适合 SQLite，而不是 Supabase / PostgreSQL？
9. 未来达到什么条件需要迁移？

---

## 17. 新项目接入检查表

- [ ] 项目已有稳定 `project_slug`
- [ ] 一个项目一个独立 `.db`
- [ ] 正式 DB 位于 `DockerData/<project_slug>/db/`
- [ ] 备份位于 `DockerBackups/<project_slug>/sqlite/`
- [ ] 正式 `.db` 已被 Git 排除
- [ ] 开发 DB 与正式 DB 分离
- [ ] Migration 已建立
- [ ] Docker bind mount 已明确
- [ ] `foreign_keys` 已验证
- [ ] WAL / busy timeout 已评估
- [ ] 每日备份已配置
- [ ] 部署前备份已配置
- [ ] 隔离恢复流程已验证
- [ ] 容器重建后数据仍存在
- [ ] SQLite 适用性已重新确认

---

## 18. 版本记录

- V1.0（2026-09-15）
  - 建立 Mac Mini 本地 SQLite 数据库统一规范；
  - 固化“一项目一数据库文件”；
  - 固化 `DockerData/<project_slug>/db/` 与 `DockerBackups/<project_slug>/sqlite/`；
  - 明确 SQLite 为 Docker Named Volume 数据库规则的嵌入式数据库例外；
  - 增加 Migration、WAL、备份、恢复、多项目隔离与 Supabase/PostgreSQL 迁移边界。
