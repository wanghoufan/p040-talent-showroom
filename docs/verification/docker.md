# Docker 验证（T089）

日期：2026-10-02（Asia/Shanghai）

## 结论：静态校验通过；isolated build/run 未执行（daemon 未响应，如实标注）

## 静态配置

- `docker compose config --quiet` → exit 0（compose 语法/schema 有效）。
- `Dockerfile`：多阶段 `node:24-bookworm-slim`；build 阶段 `npm ci --ignore-scripts` + `npm run build` 产 dist；运行阶段装 `ffmpeg` + `ca-certificates`，COPY `dist` 与 `server`，`ENV HOST=0.0.0.0 PORT=8791 SQLITE_DB_PATH=/app/data/db/personal-dance-library.db MEDIA_ROOT=/app/data/media`，`EXPOSE 8791`。
- `compose.yaml`：仅绑 `127.0.0.1:${DANCE_PORT:-8792}:8791`（独立端口，不与 P038 冲突）；volume `./var/docker:/app/data`；`MUSIC_RECOGNITION_PROVIDER=disabled`；healthcheck 命中 `/api/health`。
- `.dockerignore`：排除 `node_modules/android/.git/.env*var/temp/导入素材/reference/docs/*.log` —— 真实媒体/DB/key 不进镜像。

## 静态边界核查

- 端口：容器 8791，宿主仅回环 8792 → 不影响 P038 或其他服务。
- 只读媒体边界：媒体目录经 volume 挂载到 `/app/data/media`；镜像内不含真实素材。
- 密钥：`MUSIC_RECOGNITION_PROVIDER=disabled`，镜像不注入任何 recognition key。

## 未执行项（如实标注）

- `docker info` / `docker version` 不返回（daemon socket `/Users/zzymima0000/.docker/run/docker.sock` 无响应）；Docker Desktop UI 进程存在但 Linux VM/daemon 未就绪。
- 故 **未执行** `docker compose build` / `docker compose up` 的 isolated build/run。
- 依用户约束「未经授权不改动 Services/容器」，未擅自重启 Docker Desktop 或容器。
- 恢复（待用户授权或 daemon 就绪）：`docker compose build && docker compose up -d` → 访问 `http://127.0.0.1:8792/` 与 `/api/health` → 记录 rollback（`docker compose down`）。

## 相关（本轮确认已实现，原 HANdoff item 8 已闭环）

- CORS/OPTIONS：`server/index.mjs` 设置 `Access-Control-Allow-*` 与 `OPTIONS→204`（实测 `OPTIONS /api/catalog` = 204）。
- 静态 dist 服务：`server/static.mjs` 接入 `server/index.mjs`（`staticRoot=dist` 存在即服务，SPA 回退 index.html），实测 `GET /` = 200 `text/html`、`GET /dances/abc`（Accept html）= 200。
