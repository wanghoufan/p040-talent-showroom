# LANG 判定规则重写（batch20）

- 日期：2026-10-30
- 靶点：`server/vocal-import/canonical.mjs` `detectLanguage()`（调用点 `server/vocal-import/scan.mjs:269`，签名未改）
- 约束遵守：只改 `canonical.mjs` + 新增/修订单测 + 本文档；未改 DB、未调导入接口、未重启服务（28794 / 28796 未触碰）、未改 `scan.mjs`/`probe.mjs`/`separator.mjs`/`importer.mjs`、源音乐目录只读（仅 `readFileSync`）、未 commit/push、未跑 `npm test`、未跑真实分离。

## 1. 结论

1. 新规则**只用歌词正文**、**逐行判脚本再投票**，`title`/`artist` 完全不参与；无可用歌词行时返回 `null` 且明确不回退元数据。
2. 阈值做成模块级常量 `LANG_LINE_THRESHOLDS`：韩文行 ≥ 0.30 → `ko`；假名行 ≥ 0.20 → `null`；中文行 ≥ 0.60 → `zh`；拉丁行 ≥ 0.20 → `en`；中文行 ≥ 0.20 → `zh`。
3. 14 首真实 LRC 对照：**14/14 与人工判断一致**（旧规则错 3 首：Papillon、Let Go、All Falls Down remix，均为 `zh` 误判）。
4. 新增 `tests/vocal-import-lang-detect-v31.test.mjs` 8/8 绿；既有 `tests/vocal-import-*.test.mjs` 98/98 绿（改动 2 条写死旧口径的断言，理由见 §6）。
5. 全库 688 个 LRC 复算：146 个判定变化，逐一归类后无「中文歌被压成 en」的反向误伤（见 §5）。

## 2. 旧规则为什么必然失效

旧实现（`canonical.mjs:153` 之前）：

```js
const text = [title, artist, lyricBody].filter(Boolean).join(' ');
if (/Hangul/.test(text)) return 'ko';
if (/Kana/.test(text)) return null;
if (/Han/.test(text)) return 'zh';
if (/Latin/.test(text)) return 'en';
```

两个结构性缺陷，任何一个都足以让判定失真：

1. **元数据参与判定 + 全文首命中**：判定文本里只要有任意一个汉字就返回 `zh`。
   `王嘉尔 - Papillon` 的 LRC 正文 73 行全是英文，但 `artist=王嘉尔` 一个汉字就锁死 `zh`；
   `石玺彤 - Let Go` 同理。这不是阈值问题，是「谁参与投票」的问题。
2. **双语 LRC 无「翻译侧」概念**：网易云英文歌常配逐行中文翻译（英文行 + 中文行交替），
   按首命中必得 `zh`。`刘至佳,Lambert凌杰 - All Falls Down（remix）` 实测 20 行中文 / 21 行英文，
   旧规则取第一处汉字 → `zh`；而它的主语言是英文（中文只是翻译行）。
   旧规则连「中英各占一半」这个可用信号都丢掉了。

另外两个同源小坑（本次一并处理）：署名行写成 `[00:00.00]作词 : XXX` 时连同时间戳一起匹配失败；
网易云纯音乐占位行 `[00:05.00]纯音乐，请欣赏` 会被当成一句中文歌词（全库 78 个文件只有这一行）。

## 3. 新规则

### 3.1 取行（只取歌词，不取元数据）

```
split('\n') → 逐字歌词 JSON 还原 tx 文本 → 去 [..] 时戳 → NFKC 归一 → trim
丢弃：空行、署名行（作词/作曲/编曲/封面…，含带时戳写法）、纯音乐占位行、无字母行（纯符号/纯数字）
```

`detectLanguage({ lyrics })` 只解构 `lyrics`；`scan.mjs` 继续传 `{ title, artist, lyrics }`，多传的键被忽略，签名不变。

### 3.2 逐行归类（单行混排看主要字符）

每行统计 Hangul / 假名 / 汉字 / 拉丁字符数，取该行最多的那一类：`ko` / `ja` / `zh` / `en`；平手按 `ko > zh > en`（避免韩文句里的英文借词把行判成 en）；一个字母都没有的行不计入。

### 3.3 投票（顺序即优先级）

| 顺序 | 条件 | 结果 | 理由 |
|---|---|---|---|
| 1 | 可用歌词行数 = 0 | `null` | **不猜**。中文歌手唱英文歌正是元数据误判源；DB 允许 `vocal_language IS NULL`（`0007_vocal_tracks.sql:3`）。 |
| 2 | 韩文行占比 ≥ **0.30** | `ko` | 韩文歌常夹中文/英文翻译行，必须先于中英混排判断。 |
| 3 | 假名行占比 ≥ **0.20** | `null` | 日文，枚举没有 `ja`，维持「不臆造」。 |
| 4 | 中文行占比 ≥ **0.60** | `zh` | 中文/粤语歌的实测量级。 |
| 5 | 拉丁行占比 ≥ **0.20** | `en` | 双语带（中文 0.20–0.60）落到这里：翻译侧是中文，主语言在拉丁侧。 |
| 6 | 中文行占比 ≥ **0.20** | `zh` | 有中文但无拉丁侧（如中文歌少量符号/韩文行）。 |
| 7 | 其余 | `null` | 西里尔等枚举外语言。 |

### 3.4 阈值怎么定的（688 个真实 LRC 实测分布）

| 簇 | 实测区间 | 说明 |
|---|---|---|
| 中文 / 粤语歌 中文行占比 | **0.70 – 1.00** | 最紧的是 `陈奕迅 - Lonely Christmas` = 0.71（粤语原词 + 英文副歌）。 |
| 中英双语（英文原词 + 中文翻译行） | **0.43 – 0.50** | Senorita 中英文版 0.50/0.48、All Falls Down remix 0.49、LoveStruck 0.41。 |
| 纯英文歌 | **0.00** | — |
| 韩文歌 韩文行占比 | **0.25 – 1.00** | 中文歌、英文歌的韩文行占比全库为 **0.00**（零例外）。 |

- `hanZh = 0.60` 取在两簇正中间的 0.60：距双语簇上沿 0.10、距中文簇下沿 0.10，两边余量对称，
  且能同时满足「双语判 en」与「粤语歌仍判 zh」两个方向。
- `hangulKo = 0.30` 比最低的韩文歌（0.25）再低一档留余量，同时远离非韩文歌的 0.00。
- `kanaUncertain = 0.20`：全库只有 3 个文件含假名行（0.49 / 0.49 / 0.27），全部落在阈值上方。
- 全部阈值集中导出为 `LANG_LINE_THRESHOLDS`，改一个数即可调，不用读逻辑。

## 4. 14 首真实 LRC 对照（旧 → 新 → 人工）

数据来源：`/Volumes/三星/网易云音乐/音乐（用于转换）/`（只读），`detectLanguage({ title, artist, lyrics })`，
标题/歌手按文件名 ` - ` 切分传入（与 scan 一致）。占比均由 `lyricScriptCounts()` 实测。

| # | 曲目 | 旧 | 新 | 人工 | 结果 | 行数（ko / zh / en / ja） |
|---|---|---|---|---|---|---|
| 1 | 王嘉尔 - Papillon | zh | **en** | en | OK | 73：0 / 0 / 73 (100%) / 0 |
| 2 | 石玺彤 - Let Go | zh | **en** | en | OK | 54：0 / 0 / 54 (100%) / 0 |
| 3 | 刘至佳,Lambert凌杰 - Alan Walker-All Falls Down（remix） | zh | **en** | en | OK | 41：0 / 20 (49%) / 21 (51%) / 0 |
| 4 | 3LAU,Carly Paige - Touch | en | en | en | OK | 50：0 / 0 / 50 (100%) / 0 |
| 5 | Apink - 덤더럼(Dumhdurum) | ko | ko | ko | OK | 44：36 (82%) / 0 / 8 (18%) / 0 |
| 6 | 泫雅 - 베베 (BABE) | ko | ko | ko | OK | 70：44 (63%) / 0 / 26 (37%) / 0 |
| 7 | 4MINUTE - 미쳐 | ko | ko | ko | OK | 74：64 (86%) / 0 / 10 (14%) / 0 |
| 8 | 陈伟霆,张艺兴,宝石Gem - 歌舞：过年迪斯科 | zh | zh | zh | OK | 97：0 / 92 (95%) / 5 (5%) / 0 |
| 9 | 杨宗纬 - 初爱 | zh | zh | zh | OK | 42：0 / 42 (100%) / 0 / 0 |
| 10 | 谭咏麟 - 一生中最爱 | zh | zh | zh | OK | 54：0 / 51 (94%) / 3 (6%) / 0 |
| 11 | 陈奕迅 - Lonely Christmas（粤语） | zh | zh | zh | OK | 56：0 / 40 (71%) / 16 (29%) / 0 |
| 12 | 龙俊亨,10cm - 소나기 (Feat. 10cm) | ko | ko | ko | OK | 49：49 (100%) / 0 / 0 / 0 |
| 13 | 辉星 - Insomnia (불면증) | ko | ko | ko | OK | 40：21 (53%) / 0 / 19 (48%) / 0 |
| 14 | 曺炯雨 - 흉터 (Feat. 치타) | ko | ko | ko | OK | 58：53 (91%) / 0 / 5 (9%) / 0 |

反向验证点：
- #11 粤语歌中文行 0.71 ≥ 0.60 → 仍 `zh`，说明没有为了压 zh 把中文/粤语歌判成 en；
- #13 韩文行 0.53（另有 19 行英文钩子）→ 韩文优先，仍 `ko`；
- #3 是最紧的一首（0.49 / 0.51），只超拉丁阈值 0.31，属边界条目（见 §7）。

## 5. 全库复算（688 个 LRC，旧 vs 新）

| 变化 | 数量 | 说明 |
|---|---|---|
| `zh → en` | 59 | 英文歌 + 中文歌名/歌手/翻译行。抽查判 en 且中文行 ≥ 0.35 的只有 7 个文件，全部是英文原曲（Senorita 中英文版 ×2、All Falls Down ×2、senorita 翻唱 ×2、LoveStruck），无误伤。 |
| `zh → null` | 75 | 73 个是「只有 `纯音乐，请欣赏` 占位行」的纯音乐，2 个是只有署名行的空歌词（Clara - Peeping Tom remix）。旧规则本该给 null，是靠标题汉字硬凑出 zh。 |
| `en → null` | 11 | 无可用歌词行（只有署名 JSON / 空 LRC），旧规则靠标题拉丁字母凑出 en。 |
| `ko → en` | 1 | `BIGBANG - Lollipop Pt.2`：韩文行仅 0.25，全曲 75% 是英文行。见 §7。 |

## 6. 测试

### 6.1 新增 `tests/vocal-import-lang-detect-v31.test.mjs`（全内联 LRC，不读外部文件）

覆盖：纯中文 / 纯英文 / 纯韩文（夹英文副歌）/ 中英双语交替（含粤语反向验证）/ 中文歌手·中文歌名不影响 / 无歌词返回 null（含只有署名行、空时戳行、纯符号行、纯音乐占位行）/ 日语返回 null（含韩文歌夹日文翻译行）/ 阈值常量固定。

```
# Subtest: 纯中文歌词 → zh
ok 1 - 纯中文歌词 → zh
# Subtest: 纯英文歌词 → en
ok 2 - 纯英文歌词 → en
# Subtest: 纯韩文歌词 → ko（夹英文副歌仍是 ko）
ok 3 - 纯韩文歌词 → ko（夹英文副歌仍是 ko）
# Subtest: 中英双语逐行交替 → en（翻译行不把主语言拉成 zh）
ok 4 - 中英双语逐行交替 → en（翻译行不把主语言拉成 zh）
# Subtest: 中文歌手 / 中文歌名不得影响判定（元数据不参与）
ok 5 - 中文歌手 / 中文歌名不得影响判定（元数据不参与）
# Subtest: 无可用歌词行 → null，不退回去猜歌名/歌手
ok 6 - 无可用歌词行 → null，不退回去猜歌名/歌手
# Subtest: 日文假名 → null（枚举里没有 ja，不臆造）
ok 7 - 日文假名 → null（枚举里没有 ja，不臆造）
# Subtest: 阈值是模块级常量，便于后续调参
ok 8 - 阈值是模块级常量，便于后续调参
# tests 8
# suites 0
# pass 8
# fail 0
```

### 6.2 既有测试

`node --test tests/vocal-import-*.test.mjs` → **98 / 98 pass, 0 fail**（含 `vocal-import-v31.test.mjs` 的扫描用例：
`Touch.language === 'en'`、`4MINUTE - 미쳐.language === 'ko'` 均未受影响）。
仓库没有 `tests/vocal-import-scan*.test.mjs`，扫描相关断言都在 `vocal-import-v31.test.mjs` 内。

**改了 `tests/vocal-import-v31.test.mjs` 两条用例**（其余文件未动）。判断依据：这两条正是把「旧口径」写死的地方，
而旧口径本身就是本次要修的缺陷，故判为**测试错、新规则对**：

| 位置 | 原断言 | 新断言 | 原因 |
|---|---|---|---|
| `语言判定只输出 zh/en/ko，日文假名不臆造枚举值` | `detectLanguage({ title: '4MINUTE - 미쳐' }) === 'ko'` 等 4 条**只传 title** | 改为内联 LRC 歌词再断言；补一条「只传 title → null」 | 元数据已不参与判定，旧断言的输入方式失效；测试意图（枚举纪律 + 假名 null）保留 |
| `语言判定剔除 LRC 中文署名行（BUG-V31-QA-004）` | 署名行剔完无内容时返回 en（回退歌名/歌手） | 返回 `null` | 旧注释写着「回退歌名/歌手，不返回 null」，这正是 Papillon/Let Go 误判的机制；新规则刻意禁止回退，断言随之更正 |

## 7. 仍然判错或有争议的条目

1. **`BIGBANG - Lollipop Pt.2`（旧 ko → 新 en）**：韩文行 0.25，低于 0.30 阈值。这首歌 48 行里 75% 是英文行，
   判 en 不算错得很离谱，但严格说它是韩文歌。若后续想收，把 `hangulKo` 调到 0.25 会让它变 ko；
   代价是与英文歌的余量减少（全库非韩文歌韩文行占比均为 0.00，所以风险很低）。**未改，留作调参项。**
2. **`刘至佳,Lambert凌杰 - All Falls Down（remix）`（0.49 zh / 0.51 en）**：只差 1 行。
   属于「中英双语 remix」的天然模糊，判 en 与人工一致，但任何一侧多一句翻译就会翻面。
3. **中文原词 + 英文翻译行的 LRC**（本库 688 个里未出现）：结构上与「英文原词 + 中文翻译行」不可区分，
   会判 en。这是阈值法的固有局限，已写在注释里；目前没有真实样本触发。
4. **纯汉字、无假名的日文歌词**：假名行占比 < 0.20 时会被当中文判 zh（本库 3 个含假名文件均无此问题）。
5. **无歌词的 11 个文件从 en/ko 变 null**：这是设计选择（不猜），DB 侧 `vocal_language` 允许 NULL；
   但 UI 上「语言」列会从有值变空，属预期内的可见变化。

## 8. 是否需要重算已入库 20 首的语言标签

**需要**。这 20 首是在旧规则下扫描入库的，`repertoire_items.vocal_language` 里已经写死了 `zh`，
本次只改了「以后扫描怎么判」，不会自动修正历史行。至少已知错判 3 首（Papillon、Let Go、All Falls Down remix），
按 59/688 的错误率外推，20 首里大概率还有 1–2 首英语歌躺着 `zh`。

方案（**本次未执行**，等确认）：

1. **只读复算**：对已导入的 20 个 songId，用库里存的 `lyrics_json`（或回读源 LRC）重建 `lyrics` 文本，
   调新 `detectLanguage({ lyrics })` 得到新标签，输出 `songId / title / 旧标签 / 新标签 / 是否变化` 的 dry-run 表。
2. **人工过一遍 diff**：只对变化项确认（预计 ≤ 5 条），重点看 §7 的边界条目。
3. **单条 UPDATE**：确认后才执行
   `UPDATE repertoire_items SET vocal_language = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`，
   逐条、带 `WHERE id=?`，不用批量 SQL；改前 `SELECT` 备份旧值到 evidence 文件。
4. **不动音频、不动歌词、不动 sections/practice**，只动 `vocal_language`；改完抽查 Repertoire 接口返回。
5. 时机：等 28794 这批 20 首串行提取跑完、队列空闲后再做，避免与导入事务交叉。

## 9. 改动清单

| 文件 | 改动 |
|---|---|
| `server/vocal-import/canonical.mjs` | 重写 `detectLanguage`；新增 `LANG_LINE_THRESHOLDS`、`lyricScriptCounts`、`classifyLine`；署名行增加 `封面`、支持带时戳写法；新增纯音乐占位行过滤 |
| `tests/vocal-import-lang-detect-v31.test.mjs` | 新增，8 条用例 |
| `tests/vocal-import-v31.test.mjs` | 修订 2 条写死旧口径的语言断言（理由见 §6.2） |
| `docs/qa/evidence-2026-10-30-batch20/LANG-判定规则重写.md` | 本文档 |
