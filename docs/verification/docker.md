# Docker 验证（T089）

日期：2026-10-02（Asia/Shanghai），接续复验。

## 结论：isolated build/run / health / persistence / rollback PASS

- 用户本轮明确允许重启 Docker Desktop。原 daemon 无响应；官方 `docker desktop restart --detach --timeout 45` 因旧 AppTranslocation 进程未退出而失败。只针对核验过的旧 Docker 进程 TERM；唯一仍无响应 backend 定点退出后，官方 `docker desktop start --detach --timeout 45` 成功。未更新 Docker、未删除原容器/镜像/数据。
- Desktop 状态 running；daemon `29.7.2`；P038 `keep-fitness-workout-repo-app-1` 在重启后及 QA 回滚后均 healthy。其他项目配置未改。
- `docker compose config --quiet` exit 0。测试项目 `p040-v15-qa`，唯一端口 `127.0.0.1:8792:8791`，专用新建 QA 卷 `p040-v15-qa_qa-data`；未使用原 `var/docker`、真实媒体或真实数据库。
- 构建命令：`docker compose -p p040-v15-qa -f compose.yaml -f temp/docker-qa.override.yaml build` → exit 0。镜像 `p040-v15-qa-dance-library:latest`，ID `sha256:2fda36ff01a0c242114fbe5e2e6884aed9d0445a2950b6aabdc53398fcbe2c77`，239,901,830 bytes。
- Dockerfile 下载策略：npm BuildKit cache + npmmirror 优先，镜像缺 `electron-to-chromium@1.5.444` 返回 404 后自动回官方 npm，锁文件/版本/integrity 不变；Debian/FFmpeg 经清华镜像成功，APT 原签名校验保留，镜像失败时回原官方源。不执行依赖升级或 audit force。
- `up -d --wait --wait-timeout 45` → healthy；GET `/api/health` → 200 `{ok:true,recognition:disabled}`；GET `/` → 200 HTML；实际 bundle `/assets/index-B8ayd9aD.js` → 200；SPA `/dances/qa-fixture` → 200 HTML。
- 仅在 QA 卷导入 1 秒蓝色视频 + 440Hz 音频合成用例：ImportJob READY、保存返回 201、Range `bytes=0-9` 返回 206 与 10 bytes，证明容器内 FFmpeg/SQLite/媒体服务可用。
- 先 `down`（保留 QA 卷），再 `up --wait`：仍有 1 条合成记录，ID 与重建前相同，持久化 PASS。
- 回滚至运行前无 P040 测试服务：`down --volumes` 删除本轮专用容器/网络/合成测试卷。Node 直连 `127.0.0.1:8792` → `ECONNREFUSED`；QA 容器列表为空。未删其他项目数据，镜像保留作构建缓存。
- 原始结果：`docker-round4.json`。临时 override 位于 gitignore 的 `temp/`，完成后清理。

## 边界

这是隔离验证，未建立正式部署副本、DockerData 或长期服务；正式端口、生产数据位置、备份与长期部署仍留 Human Gate。识曲 disabled。安装时仍报告 5 个 moderate 开发依赖问题，不称零漏洞。
