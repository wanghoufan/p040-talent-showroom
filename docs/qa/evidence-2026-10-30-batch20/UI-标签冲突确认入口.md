# UI 标签冲突确认入口（batch20）

- 日期：2026-10-30
- 靶点：`src/components/VocalImportManager.tsx` 核对对话框（`openReview` / `submitReview`）
- 约束遵守：只改 `src/components/VocalImportManager.tsx` 与 `tests/browser/vocal-import-manager.test.tsx`；未改 `server/`、未改 `src/lib/api.ts`、未 commit/push、未写 `var/`、未动数据库、未启动或重启任何服务（28794 / 28796 未触碰）、未跑 `npm test` 全量、未跑 e2e。

## 1. 问题

后端 `resolve()` 已支持用 `title` / `artist` 消解 `filename-id3-title-conflict` / `filename-id3-artist-conflict`（`server/vocal-import/queue.mjs:1222-1246`），但界面核对框只提交 `lyricsRelPath` 与 `suppliedAccompanimentRelPath`。结果是：**这两类标签冲突在界面上没有任何清除路径**——用户按提示填歌词路径后提交，后端只是不再返回这两条 issue 中的任何一条被移除，于是回 `NEEDS_REVIEW`，界面按既有逻辑保留对话框并提示「仍有 N 项需要核对」，形成死循环。

真实样本：

- `石玺彤 - Let Go.mp3`：ID3 title 为 `Let Go.`（多一个句点），与文件名不一致。
- `刘至佳,Lambert凌杰 - Alan Walker-All Falls Down（刘至佳  lambert remix）.mp3`：ID3 title 用 `/` 分隔歌手，与文件名的两个空格不一致。

## 2. 改动点（文件 + 行号）

`src/components/VocalImportManager.tsx`

| 行号 | 内容 |
| --- | --- |
| 100-103 | 新增常量 `TITLE_CONFLICT_ISSUE` / `ARTIST_CONFLICT_ISSUE` |
| 172-181 | 新增 `needsTagConfirmation(job)`（issues 命中任一冲突才为真）与 `originalFileName(job)`（取 relPath 的文件名部分，原样展示） |
| 278-280 | 新增状态 `reviewTitle` / `reviewArtist` |
| 420-428 | `openReview` 用任务已解析的 `title` / `artist` 初始化两个输入 |
| 437-462 | `submitReview`：取 `tagConfirmation`，校验歌名非空 / ≤200 字 / 歌手 ≤200 字；`tagConfirmation` 为真时才把 `title`、`artist` 放进请求体 |
| 444-447 | 路径校验放宽：仅在**非**标签冲突场景才要求「至少填一个相对路径」，否则只确认标签也该能提交 |
| 465-473 | `NEEDS_REVIEW` 分支在回填 `reviewLyrics` / `reviewAccompaniment` 的同时回填 `reviewTitle` / `reviewArtist`（其余分支逻辑未改：仍保留对话框并提示剩余项） |
| 768-799 | 对话框内新增冲突说明块（文件名一侧原文 / 标签一侧当前解析值）+ 两个受控输入「歌名（不能为空，以此值为准）」「歌手（可留空，以此值为准）」 |

`tests/browser/vocal-import-manager.test.tsx`

| 行号 | 用例 |
| --- | --- |
| 190 | `标签冲突时核对框出现歌名/歌手输入，默认取解析值且提交时带上 title` |
| 234 | `歌名为空时不提交，提示歌名不能为空` |
| 254 | `非标签冲突的核对不显示歌名/歌手输入，请求体也不带 title` |

## 3. 出现条件与提交体契约

**出现条件**：`job.issues` 含 `filename-id3-title-conflict` 或 `filename-id3-artist-conflict`。其它核对场景（多歌词候选、多伴奏候选、指纹重复等）不渲染这两个输入。

**默认值**：`job.title`、`job.artist`（即当前解析结果，可能为 `''`）。

**提交体**（`POST /api/vocal-import/jobs/:id/resolve`）：

| 场景 | body |
| --- | --- |
| 无标签冲突（歌词/伴奏核对） | `{ lyricsRelPath?, suppliedAccompanimentRelPath? }`，与改动前完全一致，**不带** `title` / `artist` |
| 有标签冲突 | 在路径字段之外追加 `{ title: <trim 后非空>, artist: <trim 后可空字符串> }` |

说明：后端只要收到 `title` / `artist` 就写 `manual.title` / `manual.artist` 并移除对应 issue，所以两个字段只在标签冲突场景出现、也只在此时提交；其它场景无脑带会把「没打算改歌名」误记成人工确认。

## 4. 验证

```
$ npx tsc --noEmit -p tsconfig.app.json
（无输出，exit 0）

$ npx eslint src/components/VocalImportManager.tsx tests/browser/vocal-import-manager.test.tsx
（无输出，exit 0）

$ npx vitest run tests/browser/vocal-import-manager*.test.tsx
 ✓ tests/browser/vocal-import-manager-repeat.test.tsx (3 tests) 113ms
 ✓ tests/browser/vocal-import-manager.test.tsx (20 tests) 506ms

 Test Files  2 passed (2)
      Tests  23 passed (23)
```

新用例断言的请求体（`Let Go.` → 用户改成 `Let Go`）：

```json
{ "title": "Let Go", "artist": "石玺彤" }
```

并且断言了 body 不含 `lyricsRelPath`（该任务 `lyrics: null`，不能凭空造字段）。

## 5. 已知隐患

1. **两个输入绑定为一组**：任务只有 `filename-id3-artist-conflict` 时也会显示并提交 `title`（值为当前解析结果）。后端会顺带把 `manual.title` 置为 true、`patch.title` 写成同一个值；值不变，但人工标记比用户的实际意图多一条。若要更严格，可改成「仅冲突字段必带，另一字段仅在值被改动时才带」。
2. **文件名一侧只能显示文件名，不显示文件名解析出的歌名/歌手**：前端拿不到后端「文件名解析结果」这一字段（`job` 里没有），所以提示里给的是原始文件名（如 `石玺彤 - Let Go.mp3`），由用户自己对照；`刘至佳,Lambert凌杰 - ...` 这种带逗号/多空格的文件名需要肉眼比对。
3. **歌名 ≤200 字 / 歌手 ≤200 字是前端复刻的后端规则**，后端若调整上限，这里会先拦下并给出旧口径提示。
4. **`title` 清空到只剩空白的任务**（后端允许 `artist` 为空但 `title` 不行）：这类任务在对话框里歌名输入为空，必须由用户填写才能提交；不会自动用文件名兜底，避免界面替用户做决定。
5. 本次未在真实浏览器里对 28794 上的 20 首批量任务做点击验证（按要求不触碰该服务），组件行为只由 jsdom 用例覆盖。
