# 结构恢复同步与旧边界｜定向修复（2026-10-31）

- 输入：`docs/qa/evidence-2026-10-31-phone/QA_RESULT.md` 补测三（1.1.8 / 11）两项 FAIL/异常。
- 边界：未播放任何音频、未操作手机、未动生产库与原始素材、未做伴奏分离、未 commit / push、未跑全量回归。
- 隔离：真实只读核对使用 `var/vocal-v31-work/translation-20261031/db/qa.db` 的**副本**（复制到 `/tmp/p040probe/`），核对后删除；源库主文件未被写入。

## 一、只读探针（先确认根因，不改数据）

副本库 `사뿐사뿐`（`f259781d-…c8c57b3`）实测：

| 项 | 值 | 来源 |
|---|---|---|
| `item.durationMs`（旧单音轨 `performance_clip_id`） | **219560 ms** | `performance_clips1e80359f…` = 伴奏轨 |
| 原唱轨 `original_clip_id` 时长 | **219572 ms** | `performance_clips f5e3ea9d…` |
| 正式结构末段 | `section-9` 212740–**219572** | `sections_json` |
| 写入末段 219600 的保存 | **抛 `INVALID_SECTIONS`** | 副本上直接调用 `saveRepertoire` |

根因两条，均可复现：

1. **时长口径不一致**：校准弹层只用 `item.durationMs`（219560），服务端 `maxDuration` 取所有音轨最大值（219572）。任何落在 219560–219572 之间的合法边界在手机上被误判「段落超出歌曲总时长」。
2. **旧边界挡住无关保存**：分析按解码样本算时长，比容器/播放器长 28–40 ms，旧结构里因此存在 219600 这类段尾。原实现对所有段落一律校验 `endMs ≤ duration`，导致：只改练习设置、拆分其它段、恢复旧快照都会因为这段没动过的旧边界整体失败。
3. **弹层只在挂载时读一次 `item.sections`**：恢复旧结构 / 应用草稿发生在弹层打开期间时，地图已更新但弹层仍显示旧段数（真机 11 段 vs 地图 9 段），刷新才恢复。
4. **秒数精调按 0.1 秒回写未编辑的一端**：只改起点也会把另一端 219572 回写成 219600，凭空造出越界边界。

## 二、修复（规则，不是放宽阈值）

- `src/lib/vocal.ts`：`validateSections` 增加 `persisted` 选项——**以前落过库的段尾值放行，本次新造的越界仍拒绝**；新增 `talentDurationMs`（与服务端 `maxDuration` 同口径）。
- `src/components/VocalSectionEditor.tsx`：时长改用 `talentDurationMs`；保存时带上已落库快照；`item.sections` 变化时同步弹层——**本地无改动则直接采用最新结构，有未保存改动则保留用户编辑只提示**；秒数精调只换算用户改动的哪一端。
- `server/repertoire/service.mjs`：保存时允许「`endMs` 等于已落库边界值」的越界，新值仍拒绝；`restoreLegacySections` 以冻结快照 id 显式放行（快照本身来自曾落库的数据）。
- 全程不改写旧值：219600 保存后仍是 219600，未被裁到 219572。

## 三、定向测试（只跑相关文件）

| 文件 | 覆盖 | 结果 |
|---|---|---|
| `tests/unit/vocal.test.ts` | 旧尾段放行 / 改过的越界拒绝 / 新增越界拒绝 / 最长音轨时长 | PASS |
| `tests/browser/vocal-structure-editor.test.tsx` | 恢复后弹层同步（11→9）；有未保存改动不被覆盖；旧尾段原样保存不被改写；改起点不改另一端 | PASS |
| `tests/vocal-structure-legacy-boundary.test.mjs`（新增） | 旧尾段保存、新越界拒绝、只改练习设置人工段落不动、恢复冻结快照 | PASS |

- 变异验证（改回旧实现 → 对应用例必须红）：
  - 关闭旧边界豁免 → 3 个服务端用例红；
  - 关闭 `item.sections` 同步 effect → 恢复同步用例红；
  - 秒数精调改回双端回写 → 尾段原值用例红。
- 回归：`node --test vocal-structure-service / sync-vocal-operations / repertoire` 26 项全绿；`tsc -b` 通过。

## 四、构建与产物

- `npm run build` → `dist/index.html` `f55715d7…8a8f84`；`index-Iq2KkInT.css` `6930756a…809b6`；`index-CDzoSe5h.js` `e9c5cbf3…c8bd`。
- `npx cap sync android` 后 `android/app/src/main/assets/public/` 三份哈希与 `dist/` 完全一致。
- APK：`android/app/build/outputs/apk/debug/app-debug.apk`，`versionName=1.1.9`、`versionCode=12`、`com.wanghoufan.dancelibrary.dev`，14,087,777 bytes，SHA256 `770b41b9…22ae7c`。
- APK 内 `assets/public/index.html` / CSS / JS 与 `dist/` 三份哈希逐一相符；新逻辑文案「已同步为最新结构」「当前未保存的改动仍保留」均在包内 JS 中命中。

## 五、未完成 / 限制

- 未真机复验（本轮禁止操作手机）：恢复同步、旧尾段保存两项待下一轮真机确认。
- 未改分析器口径：草稿 `map.durationMs`（解码时长）仍可能比容器长 28–40 ms；本轮通过保存侧识别旧边界兜住，不改写任何数值。
- 未跑全量回归；`链` reviewer→qa→supervisor 未派，账本 `chain_status=OPEN`。
