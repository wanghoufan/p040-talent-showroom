# 自动化测试全套（T090）

日期：2026-10-02（Asia/Shanghai）　Node 24.19.0 / npm 11.17.0

## 结果汇总（全部通过）

| 命令 | 内容 | 结果 |
|---|---|---|
| `npm run lint` | ESLint（全仓） | 无输出 ⇒ 0 error / 0 warning |
| `npm run typecheck` | `tsc -b` | 通过（无类型错误） |
| `npm test` | Vitest | 6 文件 / **11 用例全过** |
| `npm run test:integration` | `node --test tests/*.test.mjs` | **20 用例全过**（0 fail） |
| `npm run build` | `tsc -b && vite build` | 通过（dist 生成） |

## Vitest（6 文件 / 11 用例）

- 覆盖：数据库约束/迁移、上传→处理→保存、来源音轨不变、重复来源、伪 MIME、provider 降级、路径/SSRF、endpoint/theme、状态与场景标签 AND 全组合、浏览器 shell 挂载。

## node:test（20 用例）

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
