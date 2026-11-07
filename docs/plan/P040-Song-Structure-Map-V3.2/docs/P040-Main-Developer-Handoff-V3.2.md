# P040 V3.2｜唯一主开发者完整交接

你是 P040《才艺展示厅》的唯一主开发者（可按需使用继承主模型的执行子代理，不采用 ORCA 角色编排）。用户已确认改造唱歌曲库的**歌曲地图**：音频驱动的 A1/A2/B1/B2/C1 结构、重复关系、分段播放/循环与按歌词校正。**用户最新指令：伴奏生成先暂停。执行解释覆盖所有相关 AI：伴奏生成、伴奏提取、人声分离、本地分离模型批量任务均暂停。现有音轨保留，但禁止补伴奏。**

## 必须先读真实项目

项目：`/Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅`。
按现有规范先读 `AGENTS.md`、`docs/handoff/HANDOFF.md`、`git status`，之后读本包 `docs/P040-Structure-Map-Complete-SDD-V3.2.md`，以及 `server/vocal-import/sections.mjs`、`importer.mjs`、`src/components/VocalPracticePlayer.tsx`、`VocalSectionEditor.tsx`、`server/repertoire/service.mjs`、`src/lib/vocal.ts`、`src/lib/types.ts`、相关测试、真实 QA 记录。以实时磁盘事实为准，不使用过时 HANDOFF 覆盖新代码。用户音乐目录 `/Volumes/三星/网易云音乐/音乐（用于转换）` **只读**，工作输出写现有受控 `var/vocal-v31-work/` 的独立子目录，生产库和原始素材不得直接写。

## 根因与目标

现有 `sections.mjs` 只看 LRC 同句是否重复：把重复句标副歌，其余标主歌，产生《Let Go》22 段、《senorita》29 段。这不是用户要的音乐结构。不得再优化旧阈值凑出看似漂亮的数字。

正确方案：真实原唱音频分析乐段边界/重复结构 → LRC 绑定歌词 → 输出 `前奏、A1、P1、B1、A2、B2、C1、B3、尾奏` 等地图。A2/B2 仅表示同类型出现序号，“旋律相同 / 换词 / 同词”要有独立声学证据和人工确认；Rap 未确认则不自动跳过。默认浅色、深色可切，Android 单列 390dp，保留原四 Tab。

## 本包已有实现（先测、再集成，禁止重造）

- `src/structure-map.mjs`：结构 JSON → A/B/C/U 地图，LRC 映射，按句拆分、合并、跳段循环、手动确认重复、Rap 审核、导出既有 P040 字段（不写 DB）。
- `src/cli.mjs`：现成结构 JSON + LRC → 草稿报告，不自动产生歌曲结构。
- `src/direct_mix_similarity.py`：直接读取原唱混音，Chroma CENS 相似候选；不分离音轨、不验证旋律完全一致。
- `prototype.html`：手机界面预览，只有交互，没有真实音频。
- `fixtures/`、`tests/`：合成数据和验证脚本；**不能当成真实歌准确率验收**。

## 连续执行顺序

1. 验证独立包测试，记录基线，保护所有未提交文件与 DB；绝不自动 commit/push 或真机改设置。
2. 关闭旧算法直接写 `sections_json` 的行为；旧自动结构快照保存，新音频结构写**单独的草稿数据**，绝不覆盖手工段落。后端旧 `VocalSection` 字段约束、`source` 规则继续沿用。
3. Mac mini 上以**纯原始混音、不分离音轨**的 librosa/recurrence 流程建立候选边界及重复关系；不能直接运行默认有 Demucs 的 `all-in-one-mlx`，除非证明其执行链没有分离行为。模型不能确认的类型保留 U1/U2。
4. 在 `VocalPracticePlayer` 和 `VocalSectionEditor` 增量接入点击段落跳转、整段循环、按 LRC 句锚点拆分、相邻合并、改类型、关系确认；不重写播放器、不加 Tab、不破坏原有歌词同步。
5. 以《初爱》《Let Go》《Papillon》《베베 (BABE)》《senorita》五首**真实现有原唱与 LRC**对照音乐结构，记录每段预测边界、人工边界、正确/错误分类、相似关系及 M4 处理时间，依 SDD 验收目标改进。
6. 定向自动测试 → DB 隔离副本 → 浏览器 → 按设备许可真机 → 修复 → 更新 SPEC/PLAN/TASKS/README/HANDOFF/QA；持续推进，不因任务编号停工。不准把“有结构段”“合成示例模型跑通”标作真实准确率 PASS。

## 特殊提醒

目前 Mac mini `main` 大量 V2.1/V3.1 未提交修改；近期 HANDOFF 22:47 记录了 20 首隔离入库与手机旧结构跳转 PASS，不代表结构准确。现有手机调试包 `.dev` 1.1.6 (9)，不能擅自覆盖正式包。`note11tpro` 为禁止操作设备，其他手机也需用户授权。

**结案标准：** 不做伴奏处理；五首真实歌结构准确率有证据；A1/B1/C1 与重复关系清晰可懂；按段跳转和循环/按句校正可用；原曲、LRC、舞蹈吉他、四 Tab、节目单和旧演出功能无回归；每个 AC 完成后继续执行，直到交付或真实外部硬阻塞。
