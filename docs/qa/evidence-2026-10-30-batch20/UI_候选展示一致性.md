# UI 候选展示一致性（歌词重复候选）

日期：2026-10-30

## 1. 问题定位

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 候选渲染区块 | `src/components/VocalImportManager.tsx:607-630`（改动前为 `607-634`） | 每项文案拼成「… · N 次 · 来源：lrc-repeat · 状态：待确认 · 结构：unknown · 时间：…」 |
| 候选数据来源 | `server/vocal-import/store.mjs:283`、`server/vocal-import/store.mjs:306` | `toPublicJob()` 从 `scan_json.lyricsRepeatCandidates` 原样透出，仅作提示 |
| 候选生成 | `server/vocal-import/lyrics-repeat.mjs:54-113` | 纯函数，`status` 固定 `pending-confirmation`、`sectionType` 固定 `unknown`，不推断段落 |
| 扫描摘要算法 | `server/vocal-import/scan.mjs:322-325`、`server/vocal-import/scan.mjs:343-344` | `song.status` 只由 `needsReview(song.issues)` 决定；`summary.needsReview` 只统计 `status === 'needs-review'` 的歌曲 |
| 「需核对」判定集合 | `server/vocal-import/issues.mjs:8-30` | `REVIEW_ISSUES` 白名单内的问题才算需核对 |

**结论 1（候选不计入需核对）**：`scan.mjs:261` 调用 `buildLyricRepeatSuggestions()` 后只把结果写入 `lyricsRepeatCandidates` / `lyricsRepeatStatus`（`scan.mjs:286-287`），**没有 push 任何 issue**；`issues` 全部来自歌词/音频/标签/伴奏歧义等 `REVIEW_ISSUES`。因此「需核对 0 首」与「13 组待确认候选」本就是两套口径：摘要统计的是任务级需核对，候选区块是历史遗留的逐条确认表述，不是算法漏算。

**结论 2（矛盾来自文案而非数据）**：任务处于 `PENDING_EXTRACT` 是正常入队状态，摘要与任务状态一致；唯一矛盾点是候选区块标题与每项文案暗示「需要人工逐条确认」，但界面无任何确认入口，且这些信息已被 `server/vocal-import/sections.mjs` 用于自动推测结构，属于重复暴露。

## 2. 改了什么

只改前端展示，未触碰 `lyrics-repeat.mjs`、`sections.mjs`、后端接口与 `var/` 数据。

`src/components/VocalImportManager.tsx`

1. `607`：渲染条件由 `job.lyrics &&` 收紧为 `job.lyrics && repeatCandidates.length > 0`。没有重复行时不再渲染一个「0 组」的空折叠块，减少与摘要无关的噪音。
2. `611`：标题改为「歌词重复行清单：N 组（仅供参照，无需逐条确认）」，去掉「待确认」「unknown」。
3. `615`：说明改为「这些重复歌词已用于自动推测歌曲结构（副歌、前奏 / 尾奏）。这里是原始重复行清单，仅供参考，不会阻塞导入，也不需要在本页逐条确认。」
4. `621`：每项文案精简为「重复次数 + 来源 + 时间」，删除「状态：待确认」「结构：unknown」。
5. `617`：列表 `aria-label` 同步改为「歌词重复行清单（仅供参照）」。
6. 区块仍是 `<details>`，默认折叠不变（不新增展开按钮，浏览器原生行为即可）。

`tests/browser/vocal-import-manager-repeat.test.tsx`

同步更新该文件的 3 条定向断言：标题改为「歌词重复行清单：1 组」、断言 `<details>` 默认未展开、断言「状态：待确认」「结构：unknown」不再出现、空候选改为断言区块不渲染。

## 3. 为什么

- 消除口径矛盾：候选从未进入任务级 `NEEDS_REVIEW` 判定，界面不应暗示「待确认」；改成「仅供参照，无需逐条确认」后，与「需核对 0 首」和 `PENDING_EXTRACT` 自洽。
- 保持只读定位：不改判定规则、不新增确认流程，候选继续由 `lyrics-repeat.mjs` 固定输出，仅调整展示层措辞。
- 避免误导：`pending-confirmation` / `unknown` 是模块内部字段，对用户没有可执行含义（页面无对应操作），继续展示只会让人找「确认按钮」。

## 4. 定向验证（仅改动文件）

```
$ npx tsc --noEmit -p tsconfig.app.json
（无输出，exit 0）

$ npx eslint src/components/VocalImportManager.tsx tests/browser/vocal-import-manager-repeat.test.tsx
（无输出，exit 0）

$ npx vitest run tests/browser/vocal-import-manager-repeat.test.tsx
 ✓ tests/browser/vocal-import-manager-repeat.test.tsx (3 tests) 79ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

未执行 `npm test` 全量、未跑 e2e、未启动或重启任何服务。

## 5. 未做但建议的后续

1. 真机复核：确认 13 组候选在手机上默认折叠、展开后文案通顺；建议顺带确认 `details` 点击热区在移动端够大（当前无自定义样式，`vocal-import-job__repeat` 在 CSS 中无定义）。
2. `repeatCandidateStatus` 字段（`VocalImportManager.tsx:64`）已无展示用途，可后续清理接口契约与调用方，本次保留以免动后端结构。
3. 若产品希望彻底消除重复信息，可考虑在 `sections` 已生成结构后由后端不再透出 `repeatCandidates`；属后端改动，本次未做。
