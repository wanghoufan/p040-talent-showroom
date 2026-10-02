# Mac Mini 本地项目自托管 Docker 规范

> 版本（本规范自身版本史，非治理版本号，治理版本以 Git 历史为准）：V1.1  
> 日期：2026-09-02  
> 状态：当前生效。适用于个人项目在 Mac Mini、阿里云、腾讯云、VPS 等 Docker 主机上的统一部署。  
> 配套文件：[共享 Supabase 项目与独立 Schema 数据库规范](./supabase.md)。数据库结构、RLS、Migration 与恢复门禁以数据库规范为准。

---

## 1. 目标与边界

本规范把“开发代码在哪里、正式服务在哪里、真实文件在哪里、备份在哪里、如何迁移到另一台服务器”固定为统一接口。

它管理的是应用 Runtime，不替代 Supabase：

- Docker 运行 Web、Worker、代理或未来的本地数据库容器。
- Supabase 仍是已接入项目的云端数据库、Auth、Realtime、Storage 主体。
- Docker 容器、镜像和 HTTP 200 不能证明云端数据已保存、RLS 正确或多端同步已通过。

## 2. 项目标识与四类位置

每个项目必须拥有稳定的英文小写短横线标识（`project_slug`），例如：

```text
prompt-manager
family-graph
personal-checkin
```

同一项目在 `docker`、`DockerData`、`DockerBackups` 中必须使用**完全相同**的 `project_slug`。不得因项目改名而直接改线上目录；须走迁移计划。

### 2.1 Mac Mini 标准目录（本机示例，云主机按 §2.2 映射）

```text
/Users/zzymima0000/
├── Developer/coding/1.Active/<项目目录>/       # 唯一日常开发源码
├── Developer/coding/docker/<project_slug>/     # 正式部署副本
├── DockerData/<project_slug>/                  # 真实持久化业务文件
└── DockerBackups/<project_slug>/               # 备份与恢复演练产物
```

| 位置 | 可以放什么 | 明确不能放什么 |
|---|---|---|
| `Developer/coding/1.Active/<项目目录>` | 源码、测试、Dockerfile、compose 模板、`.env.example`、文档 | 生产 `.env.local`、数据库文件、真实上传文件、生产备份 |
| `Developer/coding/docker/<project_slug>` | 经部署流程同步的正式代码、私有部署 `.env.local`、Compose 运行配置 | 日常手改业务源码、真实用户文件、数据库数据目录 |
| `DockerData/<project_slug>` | 上传文件、附件、业务导入导出、兼容数据；可分 `uploads/`、`files/`、`exports/`、`legacy-store/` | Git 源码、密钥、数据库备份、无授权的新目录或覆盖 |
| `DockerBackups/<project_slug>` | 数据库导出、业务文件快照、恢复演练产物、脱敏配置清单 | Git 提交物、原始密钥、日常运行数据 |

### 2.2 云主机目录映射

迁移到阿里云、腾讯云或 VPS 时，不要求保留 `/Users/zzymima0000`，但四种逻辑角色必须一一映射，例如：

```text
/srv/apps/<project_slug>/          # 等价 Developer/coding/docker
/srv/data/<project_slug>/          # 等价 DockerData
/srv/backups/<project_slug>/       # 等价 DockerBackups
```

业务代码和 Compose 文件只通过环境变量接收端口、公开地址和数据目录；不应把 Mac 本机绝对路径写死到应用源码。

## 3. 开发与部署分离

1. 开发、修改、测试源码只在 `Developer/coding/1.Active/<项目目录>/` 进行。
2. `Developer/coding/docker/<project_slug>/` 是部署副本，不是开发目录；不得直接改业务源码来“热修”。
3. 正常顺序：开发目录修改 → 代码检查/测试 → 用户授权提交与部署 → 部署流程同步 `docker` 部署副本 → 重建/重启既有容器 → 验证。
4. 未经用户明确授权，不创建、删除、迁移或覆盖 `docker` 部署副本、DockerData、DockerBackups 或 Docker Named Volume。
5. 未经明确授权，不 commit、push、启动新生产容器或公开新端口。

生产紧急修复可以例外，但必须同步回开发源码、留下原因和验证记录；不得只在 `docker` 部署副本留下一份不可追溯的差异。

## 4. Docker Compose 与环境变量接口

### 4.1 每个可部署项目最低产物

开发源码内应包含：

```text
Dockerfile
compose.yaml
.dockerignore
docker/env.template 或 .env.example
```

部署副本中只存在不提交的 `.env.local`。模板只能放变量名、说明和占位符，绝不放真实值。

### 4.2 推荐运行变量

```text
PROJECT_SLUG=<project_slug>
COMPOSE_PROJECT_NAME=<project_slug>
APP_PORT=<宿主机端口>
PUBLIC_APP_URL=<用户访问的完整 URL>
APP_DATA_DIR=<DockerData 项目目录>
APP_BACKUP_DIR=<DockerBackups 项目目录>
IMAGE_TAG=<可回退版本标识>
```

项目可增加自己的变量，但不得改变这些变量的职责。对已接入 Supabase 的浏览器项目：

- `NEXT_PUBLIC_SUPABASE_URL` 和 publishable key 可以进入浏览器 bundle。
- `NEXT_PUBLIC_*` 是构建期公开变量；改动后必须重建镜像，而不只是重启容器。
- API Key、数据库密码、MCP 原始令牌、`service_role` 仅放部署 `.env.local` 或受控密钥管理，不进镜像、Git、日志或截图。
- `PUBLIC_APP_URL`、域名、HTTPS、端口与 Supabase Auth Redirect URL 需要一起评估；改运行地址不能只改 Compose。

### 4.3 Compose 持久化规则

- 真实上传文件、导入导出等业务文件以 bind mount 挂载到 `DockerData/<project_slug>/` 的明确子目录。
- 本地数据库容器的数据只能使用 Docker Named Volume，例如 `<project_slug>-postgres-data`；不得放在源码目录、`docker` 部署副本或 Git。
- bind mount 的宿主机目录必须预先存在，Compose 不得静默创建未知路径。
- 当前 Prompt Manager 的 `legacy-store/` bind mount 仅为旧 JSON/SSE 兼容链路服务；它不是 Supabase 数据库、不是唯一数据源、也不是唯一备份。
- 容器可写层、`docker compose down`、镜像重建都不能被当作数据持久化方案。

## 5. 部署、升级、回滚

### 5.1 标准部署步骤

```text
1. 确认目标主机、project_slug、端口、公开 URL 和数据目录
2. 核对生产备份存在且可读
3. 在开发目录完成检查与用户授权
4. 通过受控流程更新 `docker` 部署副本
5. 使用部署 .env.local 构建并启动既有 Compose 服务
6. 验证容器状态、健康端点、日志和访问地址
7. 记录镜像版本、时间、操作者、结果和回退点
```

验证必须分层：容器 Up/HTTP 200 只代表 Runtime；登录、云端写入、RLS、多端同步和恢复仍按数据库规范分别验收。

### 5.2 回滚规则

- 每次正式部署前保留可识别的上一镜像或 Git 提交点；不能依赖“记得上次改了什么”。
- 应用回滚不自动回滚数据库 Migration。数据库回滚必须由数据库规范的发布与审核流程单独批准。
- 出现异常时先停止扩大影响：记录错误、保留日志、确认数据目录，不得直接删除容器、Volume、备份或 JSON 文件。
- 对 `NEXT_PUBLIC_*` 变量、Dockerfile、Compose、依赖版本的变更，回滚需重建镜像；普通服务端私密变量是否可仅重启，以项目文档为准。

## 6. 备份与恢复

### 6.1 备份范围

| 对象 | 位置 | 说明 |
|---|---|---|
| Supabase 结构与业务数据 | `DockerBackups/<project_slug>/` | 按数据库规范导出；含真实数据，不进 Git |
| 上传/附件/导出文件 | `DockerData/<project_slug>/` 的文件快照 | 与数据库引用关系一起验证 |
| 部署配置 | `.env.local` 的权限/变量清单、脱敏模板 | 不备份或回显原始密钥；必要密钥走受控密钥管理 |
| 镜像/版本信息 | 部署记录 | 可重建镜像不等于可以恢复数据 |

- 备份至少有两个独立位置；一个可位于本机，另一个应是受控异地位置。
- 文件与数据库恢复必须在隔离环境演练，避免把演练数据写回生产。
- 清理前先确认恢复演练、保留期和用户授权。不得使用宽泛的递归删除命令处理生产目录。

### 6.2 恢复顺序

```text
隔离主机/隔离容器
  → 恢复数据库结构与数据
  → 恢复业务文件
  → 使用脱敏配置启动应用
  → 校验行数、文件数量、权限、关键读取路径
  → 获得批准后才考虑生产恢复
```

## 7. 从 Mac Mini 迁移到云厂商

迁移到阿里云、腾讯云、VPS 的目标是更换 Runtime 主机，而不是改变业务和数据库契约。

保持不变：

- `project_slug`、镜像构建方式、Compose 服务名、环境变量语义；
- Supabase 项目、独立 Schema、Migration、RLS、Auth 与备份策略；
- DockerData/DockerBackups 的逻辑职责和恢复演练要求。

必须重新确认：

- 云主机 CPU 架构、Docker/Compose 版本、磁盘容量与防火墙；
- 目录映射、文件权限、备份目标与异地副本；
- 域名、HTTPS、反向代理、公开端口、健康检查；
- Supabase Auth Site URL/Redirect URL 与 OAuth 回调地址；
- 云厂商密钥管理、日志保留、访问控制与成本告警。

将 Supabase 换成纯 PostgreSQL、另一 BaaS 或自托管 Supabase 不属于普通 Docker 迁移：Auth、RLS、Realtime、Storage、Function/MCP 都需要专项兼容设计、数据迁移、回滚和数据库审核。

## 8. Prompt Manager 当前实例（实例，随项目替换，非通用规则）

| 项目 | 当前事实 |
|---|---|
| `project_slug` | `prompt-manager` |
| 开发源码 | 当前 Prompt Manager 项目目录 |
| 正式部署副本 | `/Users/zzymima0000/Developer/coding/docker/prompt-manager/` |
| 兼容数据 | `/Users/zzymima0000/DockerData/prompt-manager/legacy-store/` |
| 备份 | `/Users/zzymima0000/DockerBackups/prompt-manager/` |
| 运行方式 | 既有 Docker Compose 容器监听 3100；Supabase 仍为云端主库 |
| 禁区 | 不运行开发 watchdog 占用生产端口；不把旧 JSON 当唯一副本；不以 Docker HTTP 200 宣布数据库收口 |

## 9. 给开发者/AI 的固定部署提示

> 本项目必须遵守《Mac Mini 本地项目自托管 Docker 规范》。先确认 `project_slug`、开发源码目录、`docker` 部署副本目录、DockerData 持久化目录、DockerBackups 备份目录、端口、公开 URL、域名/HTTPS、环境变量和回滚方式，再修改 Dockerfile/Compose 或部署。业务源码只能在开发目录修改；`docker` 部署副本仅由部署流程更新。真实文件只放 DockerData，备份只放 DockerBackups，本地数据库只能使用 Docker Named Volume；不得把密钥、数据库文件、真实数据或备份提交 Git。迁移到阿里云、腾讯云或 VPS 时保持逻辑目录和变量职责不变，只替换主机路径、域名、密钥管理、网络与备份配置。Docker 成功启动不等于数据库、RLS、多端或恢复验收通过。

实施前，开发者必须回答：

1. `project_slug` 是什么，四类目录分别落在哪里？
2. 哪些数据用 bind mount，哪些必须用 Named Volume，为什么？
3. 哪些环境变量是公开构建变量，哪些必须私密？改动后是重启还是重建？
4. 公开 URL、端口、域名、HTTPS 和 Auth Redirect URL 如何对应？
5. 升级、回滚、备份、隔离恢复和云厂商迁移如何执行？

## 10. 版本记录

- V1.1：将正式部署副本目录统一调整为当前 `docker` 目录，并同步更新规范版本。
