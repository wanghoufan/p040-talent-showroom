# P040 歌词译文｜68 行问题定位、修正落地与防重现（2026-10-31）

- 审校对象：`docs/qa/evidence-2026-10-31-lyrics-translation/real-run/*.json`（五首真实韩文歌，292 行原文）。
- 写入位置：**隔离副本** `var/vocal-v31-work/translation-20261031/db/qa.db`。未写源 LRC/MP3、未写原隔离 QA 库、未写正式库。
- 审校人：本轮主模型（CodeBuddy / deepseek-v4.1-flash）逐句阅读，**没有另起第二个模型实例、没有并行调用同一通道**；本轮**完全没有调用** `scripts/codebuddy-auto.sh`。
- 未做：未播放声音、未听辨、未操作手机、未下载本地模型、未 commit/push、未跑全量回归。

## 1. 结果（可复算）

| 项 | 修正前 | 修正后 |
|---|---|---|
| 原文行 | 292 | 292（`lyrics_json` 五首逐首与快照逐字节相同） |
| 有译文的行 | 292 | 287（베베 前 5 行署名不再译） |
| 同源重复不一致 | 24 组 / 32 行 | **0 组 / 0 行** |
| 译文来源分布 | ai 292 | manual 68（人工审校修正）／ai 219 |
| `stale` 标记 | 0 | 0（`sourceHash` 全部按当前原文重算） |
| 改写行数 | — | 68 行改写 + 5 行删除译文 = 73 行编辑；其余 219 行保留原译 |

逐条依据（每行改前/改后/理由）写进 `corrections-2026-10-31.json`，实际落库回执写进 `correction-result.json`。

## 2. 68 行问题的成因（不是「模型翻得烂」一句话带过）

### 2.1 32 行同源不一致：分批边界把同一句拆开翻译

`server/vocal-translation/service.mjs` 原逻辑按 32 行切批，`runChunk()` 里只用 `new Map(entries.map(line => [line.text, line]))` **在批内**去重。
同一句副歌若落在第 1 批和第 2 批，就各自调用一次通道、各自生成中文，于是「同一句出现 2–4 种写法」。
这不是模型随机性，是**去重范围小于分批范围**的结构缺陷。

### 2.2 36 行独立问题：提示词只有 3 条，且只给批内上下文

原提示词只要求「长度一致 / 逐行对应 / 保留人名与英文 / 不扩写」。缺三类约束，正好对应审校里的三类错：

| 缺失约束 | 造成的实际错例 |
|---|---|
| 同句同译 | 与 §2.1 叠加，同句换说法 |
| 不许补主语/宾语 | 「请**带我**飞得更高」（M17）、「又**在那里**笑着吧」（M15） |
| 忠实保留逻辑关系 | `-도록` 读成目的「为了连觉都睡不着」（H3）、`죽도록` 读成「死一般」（H4） |

另有跨行成句导致的定语悬空（M9/M10），原提示词没有说明「歌词可能被拆行」。

### 2.3 5 行制作人员信息被当歌词：过滤条件里没有这一类

`translatableLines()` 原本只排除两种行：空行、非中文歌里本身就是中文的行（老双语 LRC 残留）。
**制作署名与段落标记不在排除范围内**，所以 `Chorus：김보아`、`All Programming by：新沙洞老虎`、`Recording/Mixing/Mastering Engineer：…` 全部按歌词送去翻译。

译错的机制是词形误导：`Chorus` 在歌词语境里最常作段落标记，模型按「段落标签」处理，输出「副歌：김보아」——于是句子从「**谁**唱副歌」变成「这是**第几段**」。
根因有两层：① 入库前没有把署名与歌词分离；② 翻译入口没有二次识别。本轮在②上加规则，①（导入端过滤）留作后续事项，见 §7。

## 3. 修正范围与判据

判据沿用审校报告的 6 类：义项错、修饰/主客关系错、语气与情态错、中文句法悬空、同源重复不一致、非歌词内容被译。

- **同源统一**：同一 `sourceHash` 只保留一种写法，选「更贴字面、更少扩写」的那一版，例如
  `아냐 아무렇지 않아 괜찮아` → 统一「不是的，我没事，我很好」；`예뻐해 줘` 七行统一「多疼疼我嘛」。
- **严重语义错误 5 条全部落地**：H1 `화려해 감춰진 모습`→「华丽却藏起来的模样」；H2 `고개`→「头」不再译「目光」；H3 `-도록` 改程度、并与下一行「病」连读；H4 `죽도록`→「拼命地」；H5 署名行整行不译。
- **署名行不译**：删除译文而不是译成中文，避免「副歌：김보아」这种把人员变段落的读法。
- **保留承接「的」的地方**：`바보처럼 사랑 때문에 떠난`→「…而离开的」、`사뿐히 날아온 떨리는`→「…颤抖着的」、`그리움에 지쳐 내리는`→「…疲惫落下的」。这三处「的」是下一行的定语，删掉反而断句，**不算悬空**。
- **同源但不同句不强行统一**：`바보처럼 사랑 때문에`（短句）与 `…떠난`（长句）是两个不同 `sourceHash`，各自成句。

## 4. 已有人工译文保护

- 写入脚本 `scripts/apply-lyrics-corrections.mjs` 对每行先读当前 `source`：`manual` / `lrc` 一律跳过并记入 `protectedLines`，只改 `ai` 行。
- 本副本**没有** manual/lrc 行，故本轮 `protected=0`；规则被执行但未命中，这一点如实记录，不当作「验证过保护」。
- 合并层的既有保证仍在：`mergeTranslations()` 里 `manual` 覆盖一切、`lrc` 覆盖 `ai`、`ai` 只刷新 `ai`。
- 修正行落 `source='manual'`：它们是人工审校结果，落 manual 后后续批量翻译不会再把错误版本刷回来；代价是「人工译文」计数从 0 变 68，属预期，不是用户自己编辑。

## 5. 防重现：三处代码改进

| 位置 | 改动 | 对应问题 |
|---|---|---|
| `server/vocal-translation/service.mjs` | 整首先按原文去重成「原文 → 行 id 列表」，再分批；一次翻译回填所有同文行 | 与 §2.1 的 32 行同源不一致直接对冲 |
| `server/vocal-translation/translation.mjs` | 新增 `isNonLyricLine()`（段落标记 + 制作署名白名单 + 全角/半角冒号），`translatableLines()` 排除之 | 与 §2.3 的 5 行署名对应 |
| `server/vocal-translation/provider.mjs` | 提示词补：同句必同译、截断可停在承接词但不许补成分、署名与段落标记原样返回、保留逻辑关系（程度不读成目的） | 与 §2.2 的三类错对应 |
| `src/lib/vocal/translation.ts` | 客户端镜像 `isNonLyricLine()`，`summarizeTranslations()` 同口径排除 | 否则练习页会对署名行永远显示「还差 5 句」 |

`isNonLyricLine()` 在五首 292 行上实测：命中 5 行、**误伤 0 行**（`울고 있는 너에게：말해`、`Tell me I am your babe babe` 等均判为歌词）。

## 6. 定向测试与构建

| 项 | 命令 | 结果 |
|---|---|---|
| 翻译服务 | `node --test tests/vocal-translation-service.test.mjs` | **19 pass / 0 fail**（新增 2 例：跨批同文只送一次且译文完全一致；署名与段落标记不送通道、不计缺） |
| 客户端规则 | `npx vitest run tests/unit/vocal-translation.test.ts` | **12 pass / 0 fail**（新增 1 例：署名不算缺、真歌词不误判） |
| 构建 | `npm run build`（`tsc -b` + `vite build`） | 通过 |
| 同步 | `npx cap sync android` | 通过（3 个插件） |
| 打包 | `./gradlew assembleDebug` | BUILD SUCCESSFUL |

产物核对：

| 项 | 值 |
|---|---|
| 版本 | **1.1.10 (13)**，`aapt2 dump badging` 读出 `versionCode='13' versionName='1.1.10'` |
| 包名 | `com.wanghoufan.dancelibrary.dev` |
| APK | `android/app/build/outputs/apk/debug/app-debug.apk`，14,088,309 bytes，SHA256 `4aac1a523961ad9919d9c1db6975febd387da14381e22a4d8b46302102896329` |
| `dist/index.html` | SHA256 `95ba0c6be5b88df4ed67c6e34d820794992f5f339d36095f22711229b7310da0` |
| APK 内 `assets/public/index.html` | 同上哈希（逐字节一致） |
| 版本注入 | `dist/assets/index-DbxWeolB.js` 内含 `1.1.10`；CSS `index-Iq2KkInT.css` 已在包内 |

## 7. 仍不确定项（不造结论）

1. **베베 line-1「Chorus：김보아」的具体身份**：能确定「是人员署名、不是歌词」（故整行不译），但「副歌演唱」还是「和声编写」需查专辑内页，本轮未查。
2. **덤더럼 `화려해 감춰진 모습`**：按并列处理（「华丽却藏起来的模样」）。若原意是「华丽地（被）掩藏起来」，则仍是副词修饰；无母语者确认。
3. **사뿐사뿐 line-16 `고개`**：已按字面改「头」。但下一行是 `두 눈에`（双眼里），原文也可能是「跟着我转过来的（那张）脸」；未定。
4. **사뿐사뿐 line-24/55 `꿈을 꿔도 내가 보이게 될 거야`**：主语落点两解（我出现在你梦里 / 你看见我），统一为「你也会看到我」，属择一，非唯一正解。
5. **베베 line-54 保留 `I feel like` 英文**：与 line-28 一致，属刻意，不是漏译；但也可整句汉化，取决于产品风格口径。
6. **75 行「译文＝原文」**（英语 hook、`La la la`、`U make me baby girl`）是刻意照录，不代表漏译，也不计入中文质量分母。
7. **听辨准确率仍未测定**：本轮依旧没有播放声音，无法判断译文是否贴合演唱情绪；母语者复核同样未做。任何百分比都不能报。
8. **Insomnia line-6 `내 고백에 등돌린 채`**：现译「面对我的告白转过身去」保留未改；`-에` 也可能读作「因为我的告白」。存疑但未改动。
9. **署名过滤的边界**：`isNonLyricLine()` 用角色白名单，覆盖常见英文署名；韩文署名（如 `편곡：…`）不在白名单内，可能仍被当歌词。本轮数据未触发。
10. **导入端未加同款过滤**：本轮只在翻译入口拦截，源 LRC 里的署名行仍然入库、仍显示韩文原文。是否在导入端剔除属产品决策，未做。

## 8. 复现命令

```bash
# 1) 应用修正（只接受隔离副本；脚本内置拒绝正式库与原 QA 库）
node scripts/apply-lyrics-corrections.mjs \
  --db var/vocal-v31-work/translation-20261031/db/qa.db \
  --corrections docs/qa/evidence-2026-10-31-lyrics-translation/corrections-2026-10-31.json \
  --out docs/qa/evidence-2026-10-31-lyrics-translation/correction-result.json

# 2) 定向测试（不要跑全量）
node --test tests/vocal-translation-service.test.mjs
npx vitest run tests/unit/vocal-translation.test.ts
```
