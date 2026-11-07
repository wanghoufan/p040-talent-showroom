# P040 V3.2 / V3.3 复核（非手机）｜结构与歌词翻译真实风险

- 日期：2026-10-31（Asia/Shanghai）
- 范围：只读复核 + 定向修复；**未** 操作手机、**未** 读写生产库、**未** 动原始素材、**未** 播放声音、**未** 下载模型、**未** 做音频分离、**未** commit / push。
- 未触碰 `docs/qa/evidence-2026-10-31-phone/`（Luna 在用）。
- 隔离环境：本轮探针与测试均用 `mkdtemp` 临时目录 + 临时 SQLite，跑完即删；生产库 SHA 未变（未打开）。

## 一、结论

复核 5 个关注点后确认 3 个真实缺陷 + 1 个并发数据回滚隐患，均已修复并补定向测试；其余项经核查为正确或按设计保守。

| 关注点 | 核查结果 | 处理 |
|---|---|---|
| 保护人工结构 | **有缺陷**：草稿应用闸门用曲目 `revision`，练习设置自动保存就会推进 revision，导致草稿长期 409，`重新读取草稿` 也解不开 | 改为「正式结构指纹」比对，已修 |
| Rap 明确确认 | 正确：`rapApproved` 显式持久化；拆分/合并/改类型/改时间都重置；导出未确认写 `false`；服务端合并不凭空确认 | 无改动，补变异验证 |
| 长歌词 / 离线翻译 | **有缺陷 2 个**：①通道不可用时连本地缓存都不查，离线复用形同虚设；②批量结束用入口快照整份回写，会把人翻译进行中改的人工译文盖回旧值 | 均已修 |
| 演出默认设置 | 正确：默认原文、切歌重置；译文只读已同步数据，现场不发请求 | 无改动，补切歌重置测试 |
| 定向测试真实性 | 抽样变异验证：改坏规则后测试确实变红 | 见 §四 |

附带修正：老双语 LRC 里中文行被算成「缺译文」，客户端永远挂着假的「翻译缺失 N 句」，服务端还会把中文行当原文送去翻译。客户端与服务端口径已统一。

## 二、缺陷与修复

### D1 草稿应用被练习设置"锁死"（保护边界过宽）

- 复现：生成结构草稿 → 播放器改倍速（自动存 `practice`，revision +1）→ 应用草稿 → `409 CONFLICT: 曲目在生成草稿后已被修改`。
- 再点「重新读取草稿」仍 409：复用路径不刷新 `baseRevision`，只有 `重新分析`（重跑 librosa）能解，代价高。
- 根因：`applyStructureDraft` 用整行 `revision` 判断冲突，但 practice / lyrics / translations 的写入也会推进 revision，与"结构是否被改"无关。
- 修复 `server/vocal-structure/service.mjs`：生成草稿时把正式结构指纹写进 `analysis_json.baseSectionsHash`（无需新迁移）；应用时只比对指纹。结构真被改过（含被清空）仍 409；旧草稿无指纹时退回 revision 比对。
- 安全性未降低：人工结构仍需 `replaceManual` 显式确认；变异去掉该守卫后测试立即变红。

### D2 通道不可用时缓存不生效（离线复用失效）

- 复现：先译好一首→关闭通道→另一首同文歌曲翻译 → `cached=0`、`remaining=2`、库里 0 条译文，直接 `CHANNEL_UNAVAILABLE`。
- 根因：`if (translator?.available)` 把缓存查询和通道可用性绑在一起。缓存键只依赖 provider/model，与通道此刻能否启动无关。
- 修复：有 `translator` 就查缓存；只剩真正需要走通道的句子才判 `TRANSLATION_UNAVAILABLE`。

### D3 批量翻译回滚人工译文（并发写回）

- 复现：曲目已有 manual 译文 → 启动批量翻译 → 期间用户在纠错框改同一句 → 批量结束 → 人工译文变回**旧文本**。
- 根因：`persist(item, lines)` 把入口读到的整份快照写回；`mergeTranslations` 里 manual 覆盖 manual，于是旧的人工文本赢过新的人工文本。
- 修复：只提交本次真正产出的行（LRC 关联 / 缓存 / 通道），交给 `saveRepertoire` 与库里最新译文合并（人工优先）；`changed` 判定同步改为「有产出才写库」，不再空写推进 revision。
- 副作用检查：二次翻译仍 `NOTHING_TO_DO`（无产出即不写库），既有用例全绿。

### D4 老双语 LRC 的中文行被算成"缺译文"（客户端/服务端口径不一致）

- 复现：`한/中` 交替的歌词 + 两行 LRC 译文 → 客户端 `3 句 · 2 译 · 缺 1`，按钮永远点得动，点下去服务端回 `NOTHING_TO_DO`；未配上的中文行还会被当韩语送通道。
- 修复：服务端新增 `translatableLines()`（非中文歌里本身是中文的行不算待译），客户端 `summarizeTranslations()` 采用同一口径。

## 三、测试（新增 9 个用例：7 个针对已复现缺陷、先红后绿；2 个补覆盖）

| 用例 | 文件 | 修复前 | 修复后 |
|---|---|---|---|
| 草稿生成后只改练习设置仍可应用；正式结构被改过才判冲突 | `tests/vocal-structure-service.test.mjs` | 红（MANUAL_OVERRIDE/CONFLICT 卡死） | 绿 |
| 通道不可用时仍复用本地缓存 | `tests/vocal-translation-service.test.mjs` | 红（cached=0） | 绿 |
| 老双语 LRC 里没配上的中文行不算缺译文、不送通道 | 同上 | 红（total=3、中文行进通道） | 绿 |
| 长歌词 120 句按批（4×32）全部落库、时间轴不动 | 同上 | 新覆盖 | 绿 |
| 批量翻译过程中人工改的译文不被回滚 | 同上 | 红（回滚成旧文本） | 绿 |
| 老双语歌词不再挂假「翻译缺失」按钮 | `tests/browser/vocal-practice-translation.test.tsx`、`tests/unit/vocal-translation.test.ts` | 红 | 绿 |
| 切到下一首时译文开关回到原文 | `tests/browser/vocal-performance.test.tsx` | 新覆盖 | 绿 |

## 四、测试真实性与命令

变异验证（改坏实现→跑测试→比对还原，文件 `cmp` 确认与还原前完全一致）：

1. `isRapConfirmed` 兜底改成"永远已确认" → `tests/unit/vocal-structure.test.ts` 变红。
2. 删掉 `applyStructureDraft` 的 `MANUAL_OVERRIDE` 守卫 → `已有手工结构时应用草稿必须显式覆盖` 变红。
3. 删掉演出页 `setShowTranslation(false)` → 新增切歌重置用例变红。

本轮命令与结果（均为定向/全量测试，无真机、无声、无生产库）：

```text
node --test tests/*.test.mjs          231 pass / 0 fail
npx vitest run                        249 pass / 1 fail（既有、非本轮）
npx tsc -b                            通过
npx vite build --outDir .local/build-check --emptyOutDir   通过（121 modules）
```

- 唯一失败：`tests/unit/pending-shares.test.ts`（分享提交状态映射 `OFFLINE_SAVED` → 实得 `NEEDS_INPUT`）。该用例与 `src/lib/pending-shares.ts` 均未在本轮改动（`git status` 无变更），属既有缺陷，不在本次范围，未修。

## 五、未完成 / 遗留

- 真机验收仍 OPEN（本轮禁止操作手机）：练习默认双语、演出切换、结构校准、Rap 确认的真实观感未验。
- 译文质量逐句审校仍 OPEN（仅服务口径与抽样）。
- 五首真实歌的 V3.2 人工听辨纠错未做。
- `restoreLegacySections`（恢复旧结构）仍无二次确认：若在应用草稿后又手工改过结构，恢复会用最早快照覆盖当前结构且草稿转 DISCARDED。属显式按钮行为，本轮不改，记录为观察项。
- 生产库迁移 `0009`/`0010` 未执行（需用户授权）。
