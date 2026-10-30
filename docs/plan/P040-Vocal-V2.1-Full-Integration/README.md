# P040 V2.1 唱歌模块｜主开发者开工代码包

日期：2026-10-30。模式：**唯一主开发者**。

**性质：完成并测试的独立源码组件 + SQLite 增量迁移草案 + 完整主开发者交接，不是已集成到用户 Mac mini 的 APP，也不是全套 V2.1 APK。**

## 本次已实际实现（可立即移植）

- `src/lib/vocal/model.ts`：新增双音轨与时间轴模型、旧 `audio/audioRole` 兼容、演出默认伴奏、不用原唱伪装伴奏、同媒体鉴别、时长偏移校验。
- `src/lib/vocal/lrc.ts`：中、英、韩 LRC 逐句时间戳解析、BOM、`offset`、多时间标签、校准警告。
- `src/lib/vocal/timeline.ts`：歌曲结构合法性、Rap 重叠合并/跳转、按 N 句循环、单次去 Rap 合练、全曲循环和秒数跳转。
- `src/lib/vocal/tracks.ts`：当前播放时切换音轨，尽量保持时间位置、暂停状态、音量、静音、倍速；目标加载失败回退原轨。
- `src/lib/vocal/import-contract.ts`：后续 AI 智能导入统一结果接口、可追踪任务状态、文件角色识别、批量文件匹配及稳定内部命名。
- `server/db/migrations/0007_vocal_practice.sql`：增量保存 `vocal_tracks`、`vocal_analysis` 与歌曲语言，旧单轨精确迁移；**只在数据库副本验证后才可用于实际工程**。
- `tests/`：Node.js 原生测试，含五首演示 LRC 与真实 SQLite 内存迁移回归。

## 当前测试

在本包目录执行：

```bash
npm test
npm run typecheck
```

测试无需 npm install 或第三方依赖，Node 22+ 和 TypeScript 5+ 即可。已执行 `27` 项独立测试，通过 `27` 项。测试里的音频播放器是模拟媒体对象，**不能冒充真机测试**。

## 不能直接把 ZIP 整包覆盖到 P040

用户的 P040 正式目录存在大量未提交变更。必须先读实际代码与 diff，按需移动独立模块和移植服务层。SQLite 迁移命名应以项目最新 migration 目录为准。不要覆盖 `src/lib/types.ts`、`TalentDetailPage.tsx`、`PerformancePage.tsx` 或 `server/repertoire/service.mjs` 等整文件。

完整集成顺序与风险详见 `docs/INTEGRATION.md`、`P040-Vocal-Main-Developer-Handoff-Complete.md`。

## 已确认目标范围

- 现有 Android 底部四 Tab 和顶部才艺菜单不变；曲库状态、语言两行紧凑单行筛选；无 Rap 比例筛选。
- 一首曲目两条独立媒体；练唱优先原唱；演出默认伴奏；现场切换保持位置；节目单混排，离线缓存两轨和同步歌词。
- 歌曲段落地图、重复与新歌词区别、逐句循环、去 Rap 合练。
- **以后 AI 智能导入作为主要导入路径**：用户只投原唱 MP3，Mac mini 后台识别、分离伴奏、歌词匹配/对时、统一命名；本轮仅冻结兼容接口，不因模型或 API Key 尚未确定阻塞 V2.1 开发。分轨手动导入只作为过渡/失败兜底。

## 尚未完成（禁止误报）

- SQLite 数据迁移、API 完整写入及同步、Android APP UI 集成、歌单/演出页面联动、真机数据回归、完整歌词/结构自动识别、真实 MP3 人声分离、APK、部署。
- 主开发者在 Mac mini 本地目录执行以上集成，遇到必须本人授权的设备安装、数据不可逆修改、推送发布时按项目规则处理。
