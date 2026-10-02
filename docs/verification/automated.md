# 自动化测试全套（T090）

日期：2026-10-02（Asia/Shanghai）　Node 24.19.0 / npm 11.17.0

## 结果汇总（全部通过）

| 命令 | 内容 | 结果 |
|---|---|---|
| `npm run lint` | ESLint（全仓） | 无输出 ⇒ 0 error / 0 warning |
| `npm run typecheck` | `tsc -b` | 通过（无类型错误） |
| `npm test` | Vitest | 7 文件 / **14 用例全过** |
| `npm run test:integration` | `node --test tests/*.test.mjs` | **24 用例全过**（0 fail） |
| `npm run build` | `tsc -b && vite build` | 通过（dist 生成） |

## Vitest（7 文件 / 14 用例）

- 覆盖：数据库约束/迁移、上传→处理→保存、来源音轨不变、重复来源、伪 MIME、provider 降级、路径/SSRF、endpoint/theme、状态与场景标签 AND 全组合、浏览器 shell 挂载。

## node:test（24 用例）

- 今晚歌单：重复 id / 未知 id 被拒且不破坏已有歌单；软删除曲目不可入单。
- recognition：off / 异常 / 超时 / 坏候选 均保留导入回退。
- 安全：媒体根拒绝 traversal 与 symlink 逃逸（保留 Unicode 名）；来源链接仅接受精确注册的 HTTPS 主机、不做通用抓取；SSRF 地址拒绝 local / link-local / mapped IPv4 / reserved 段。
- 离线：`sync manifest` 输出快照与媒体元数据，不含绝对路径。

## 构建与打包

- Web bundle：`npm run build` 通过。
- Android debug：`:app:assembleDebug` BUILD SUCCESSFUL。
- Android release（unsigned）：`:app:assembleRelease` BUILD SUCCESSFUL → `android/app/build/outputs/apk/release/app-release-unsigned.apk`（8,560,218 bytes），证明 release 可构建性（正式签名留 Human Gate）。
- Docker：`docker compose config` 校验通过（静态）。

## 说明

- `npm audit` 曾去除 critical/high，仍余 5 个 moderate 开发依赖项，**不得表述为“零漏洞”**。
- 未运行 `audit --force`。

## 接续复验（2026-10-02）

`npm run lint`、`npm run build`（含 `tsc -b`）、Vitest 6 文件/11 用例均通过；集成测试沙箱内因 localhost `listen EPERM` 失败，获准在可监听环境复跑后 20/20 通过。`npx cap sync android`、Java 21 + Gradle 8.14.3 `:app:assembleDebug --offline` 均成功；复用本机缓存，无新增下载。新 bundled debug 包 11,297,194 bytes，SHA-256 `2a9d96e8d825188ba8663894b0c4b923fb105dba1c6b8d51843e7c8a4393889c`，证书 SHA-256 `8e82a7975008e8ec87ff0f2ecadf495b5263effa34aaec9ab6f135ebea911cf3`（Android Debug），已覆盖安装固定 USB 真机。正式签名未改。

当前 unsigned release 亦已离线重建：8,560,442 bytes，SHA-256 `3938a8e75665711b96e3400a7f75feb101ca0cf2311f5904113d46e4cc63a8e8`。Docker T089 已补 isolated build/run/health/合成媒体回归/重建持久化/rollback 全通过，见 `docker.md` 与 `docker-round4.json`。


## 2026-10-03 批量分类 + 封面合并

最终合并版本 lint / Vitest 7 文件 14 用例 / tsc + Vite build 全通过；node:test 24 用例通过（首次沙箱 EPERM 是端口能力限制，授权环境复跑全绿）。新增 3 个界面测试涵盖筛选全选、请求 ID/手机元数据与缓存保护、连接失败保留；4 个实际 HTTP + SQLite 测试涵盖三种状态、标签增删替换清空、整批校验、写入中途回滚。Java21 缓存离线 debug/release 构建成功；最终 bundled debug 固定 note11tpro 复验通过。
