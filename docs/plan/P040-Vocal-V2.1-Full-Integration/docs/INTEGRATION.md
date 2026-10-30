# P040 V2.1 源码集成步骤（已核对真实仓库）

> 仅指导唯一主开发者在 **Mac mini 本地工程副本**执行。当前项目 `main...origin/main` 有大量未提交改动；不可 reset、checkout、覆盖。先完成本地 Git diff、DB+媒体文件索引的实际备份，备份验证无误，再开发。

## 1. 精确起点

- `src/lib/types.ts`：`TalentItem.audio` 单引用、`audioRole` 为 REFERENCE / ACCOMPANIMENT。**保留两个旧字段**，仅为 VOCAL 新增 `vocalTracks?: VocalTracks`、`vocalAnalysis?: VocalAnalysis`、`languageCode?: 'zh'|'en'|'ko'|'other'|'und'`。
- `server/db/migrations/0003_repertoire.sql` 现有 `repertoire_items` 单一 `performance_clip_id`；已核对 migration 最后为 `0006_requests.sql`，草案使用新 `0007_vocal_practice.sql`；先测试 DB 副本，旧 migration 不修改。
- `server/repertoire/service.mjs` 需要扩展 `getRepertoire` 以读取 `vocal_tracks` 及 `vocal_analysis`，并分别序列化原唱/伴奏 MediaFile。**不能只是向旧 `saveRepertoire` 传 `vocalTracks`**：它当前通过严格的 `fields` 白名单会报 BAD_REQUEST。
- `server/repertoire/service.mjs::attachRepertoireMedia` 当前每次会覆盖 repertoire_items 中的旧 `source_media_id`、`performance_clip_id`、`audio_role`。必须以角色为参数为 VOCAL 更新 `vocal_tracks` 表，确保补传伴奏不会覆盖原唱；GUITAR 保持旧路径。要保证同一导入任务重试幂等，并继续使用既有导入队列流程。新 AI 导入以后也走同一关联函数。
- `server/sync-operations.mjs` 的 `columns`/`allowed` 字段严格枚举；`src/lib/offline-editing.ts` 的本地排队与冲突合并也须适配字段；不要只改后端而忘记离线写操作。大 JSON 分析更建议使用专用带 revision 的事务写接口，不能在旧 `columns` 映射里直接添加任意对象。

## 2. 媒体及离线

- `src/lib/repertoire-store.ts::playableTalent` 当前只用旧 `item.audio`；改为以活动音轨为准生成当前需要的 MediaFile，但不能把缺失的伴奏默认映射为原唱。
- `src/lib/offline-manifest.ts::mediaEntries` 当前只返回 `item.audio`、cover、scores。仅对 VOCAL 从 `vocalTracks` 收集原唱与伴奏（按 URL 去重），并保留旧音频回退；**不能把同一原唱冒充两个角色**。离线校验继续同时查 `sha256/version/size` 和物理文件存在。
- `src/lib/sync.ts::prepareOffline` 当前调用 `mediaEntries`；整合后能下载两轨，但需确保歌词/结构元数据在同步快照里被保存在本地，**不能因为 LRC 单独存库而忘记离线**。对演出模式，缺伴奏应明确显示未准备好；没有原唱但伴奏存在时，仍可正常伴奏演出，原唱按钮禁用。
- `src/lib/program.ts` 仍用 `{kind,id}`，绝不能分成两个节目。`src/pages/TonightPlaylistPage.tsx` 恢复混排/排序/去重与缓存状态。
- `src/pages/PerformancePage.tsx`：VOCAL 默认取伴奏，切换按钮只对有两轨且可读时可用；切歌停止、默认伴奏、手动点击才播放；演出不继承练习中的跳 Rap/N 句循环/倍速。舞蹈、吉他原逻辑保留。

## 3. 练唱及曲库

- `src/pages/TalentLibraryPage.tsx` 的 VOCAL 搜索下方用两行紧凑 `状态` 与 `语言`；每个标签同一行，原 `LibraryFilters` 的其它入口不改吉他/舞蹈。双列卡片、顶部才艺导航、底部四 Tab 完整保留。
- `src/pages/TalentDetailPage.tsx` 对 VOCAL 嵌入结构地图、时间轴同步歌词、按句循环、可调秒数进退、Rap 跳段和一遍合练，并使用本包的 `lrc.ts`、`timeline.ts`、`tracks.ts`。对 GUITAR 保持旧分支，不用新的训练组件替换吉他。
- `src/components/MultiImportSheet.tsx` 当前每个文件独立创建一首曲目，**不能把一首歌的原唱、伴奏、LRC 当成三首歌**。新增按 songId 分组导入和去重。V2.1 阶段手动/批量导入可用，但最终主入口是后续 AI 智能导入（原唱 MP3 → 自动识别/分离/歌词对齐/结构），所以将自动导入任务输出写入统一同一 songId 的对象。
- AI 选型、具体 API Key 和模型 ID 尚未核实：不要发起付费服务、索要用户明文密钥或阻塞 V2.1。

## 4. 迁移安全与 QA

1. 在测试 DB 副本跑 `0007`，检查原 VOCAL 单轨按原 `audioRole` 映射，无一变两；吉他完全不受影响；测试重复导入、修改音轨后旧媒体仍在、软删恢复和删除引用。
2. 先运行本包 `npm test`，再并入 P040，执行其 `npm run typecheck && npm run lint && npm test && npm run build && npm run test:integration`；真实依赖以本机项目安装为准。
3. 用五首原创双音轨与 LRC 回归：0 Rap、少 Rap、多 Rap、中英韩文字、同旋律新词、按四句循环、Rap 连段、多来源文件偏移、音轨切换失败回退。
4. 今晚节目单的混排、改序、准备离线演出（包括坏文件重下）、演出伴奏默认、原唱切回、切下一首手动播放；断网与杀进程后恢复。
5. 任何真机 ADB 安装、发布或远端 push 需依项目授权。测试必须保证 `com.wanghoufan.dancelibrary.dev` 旧数据不被清空；禁止因 release APK 是空数据而误覆盖。所有测试结果有可核查日志/截图记录。

## 5. 完成判据

本独立 starter **已通过 Node 22 + TypeScript 类型检查及 27 项单元测试**。这些是可复用代码验证，并非 P040 源码合并通过、设备演出通过或自动 AI 导入完成。只有本地主开发者完成 API/DB/前端/缓存集成及真实回归后，才能报告整个 V2.1 已完成。
