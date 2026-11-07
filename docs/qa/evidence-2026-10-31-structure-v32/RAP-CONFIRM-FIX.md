# Rap 显式确认修复｜V3.2（2026-10-31）

## 问题

结构草稿「应用」时把所有段写成 `source='manual'`，前端跳过逻辑又把 `rap + source='manual'` 当成「已确认 Rap」。
结果：只要草稿里出现 rap 段（无论算法猜的还是用户只改了类型），应用后就会自动跳过；确认状态也没有落库字段。

## 根因

1. `toP040Sections` 不输出 Rap 确认状态，正式 `VocalSection` 也没有该字段。
2. `src/lib/vocal.ts` / `src/lib/vocal/structure.ts` 用 `source === 'manual'` 推断确认，混淆了「保存过结构」和「确认过 Rap」。
3. 编辑器只有类型选择，没有 Rap 逐段确认入口；拆分/合并/改时间还会沿用旧确认。

## 修复

- 正式结构新增可选 `rapApproved?: boolean`，只对 `type='rap'` 生效；服务端 `normalizeSections` 原样持久化 `true/false`，非法值拒绝。
- 草稿导出 `toP040Sections` 对每个 rap 段显式写 `rapApproved: section.approvedRap === true`；未确认就是 `false`，绝不因 `source='manual'` 变成已确认。
- 应用草稿路径禁用旧数据兼容兜底（`legacyRapFallback: false`）；只有显式 `true` 才确认。
- 旧正式数据没有该字段：读取时仅在 `source='manual'` 且缺字段时沿用旧行为；有显式 `false` 时绝不跳过。
- 跳过判断统一走 `isRapConfirmed`：播放器提示、Rap 区间、待确认数量三处一致。
- 编辑器新增「Rap 跳过确认 / 取消确认」；改起止时间、拆分、合并、改类型都会撤销原确认，必须重新确认。
- 草稿面板文案改为「应用只保存段落，不等于确认 Rap」。

## 定向验证（全部隔离数据）

| 命令 | 结果 | 日志 |
|---|---|---|
| `node --test tests/vocal-structure-map.test.mjs tests/vocal-structure-service.test.mjs tests/repertoire.test.mjs tests/sync-vocal-operations.test.mjs` | 57 PASS / 0 FAIL | `rap-fix-node.log` |
| `npx vitest run tests/unit/vocal.test.ts tests/unit/vocal-structure.test.ts tests/browser/vocal-structure-editor.test.tsx tests/browser/vocal-practice-player.test.tsx tests/browser/vocal-import.test.tsx` | 5 files / 65 PASS | `rap-fix-vitest.log` |
| `npx tsc -b` | exit 0，无输出 | `rap-fix-tsc.log` |
| `npx vite build --outDir .local/build-check --emptyOutDir` | exit 0，产物在 `.local/build-check` | `rap-fix-build.log` |

新增/更新用例覆盖：

- 草稿导出的 rap 段 `source='manual'` 但 `rapApproved=false`，不会跳过；显式 `approveRap` 后才 `true`。
- 旧正式结构缺字段时保持旧行为；显式 `false` 或算法段一律不跳过。
- 应用草稿后正式 rap 段持久化为 `false`；确认/取消确认都能原样落库；非布尔值被拒绝。
- 编辑器可确认、取消；拆分、合并、改类型撤销确认。
- 无 Rap、未确认 Rap 时「跳过 Rap」不可用并给出原因。

## 边界

- 未改正式库、未读写用户原始素材、未做音源分离、未操作手机、未 commit/push。
- 未下载或接触任何翻译模型；韩中翻译**当时**仍未做。2026-10-31 后续按用户决定改走 CodeBuddy CLI 云端通道完成，见 `docs/qa/evidence-2026-10-31-lyrics-translation/`。
- 未做人工听辨准确率与真机验收；五首真实数据仍待人工复核。
