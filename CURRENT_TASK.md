# CURRENT_TASK｜P040 V1.3-R3 A4 手机交付与专项验收

- project: `040-ing-才艺展示厅`
- project_root: `/Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅`
- task_id: `P040-V1.3-R3-A4-MOBILE-DELIVERY`
- approved_by_user: `2026-11-04`（明确回复 1，批准 R3）
- status: `READY`
- phase: `DEVELOP`（仅表示可由主开发者接手实施，本次云端只写入计划）
- plan_path: `docs/plan/P040-A4-Mobile-Delivery-V1.3-R3.md`
- previous_plan_path: `docs/plan/P040-Mobile-Lyrics-Experience-V1.3-R2.md`
- previous_task_archive: `docs/plan/P040-V1.3-R2-CURRENT_TASK-ARCHIVED.md`
- previous_task_status: `IMPLEMENTED_WITH_OPEN_ACCEPTANCE`（旧 R2 主体已实现；未完成项由 R3 接手）
- gui_forwarding: `false`
- scope: `P040_ONLY`
- execution_mode: 保持 P040 既有开发模式，按项目 `AGENTS.md` 与实际 HANDOFF 运行；不额外创建 ORCA Gate

## 开工与执行

你是 P040 项目现有开发执行者。先读取本文件、`docs/plan/P040-A4-Mobile-Delivery-V1.3-R3.md`、`AGENTS.md`、`docs/handoff/HANDOFF.md`、R2 QA 及代码实况。核验 Git、隔离数据库、设备访问，保护未提交更改。**不要重复执行 R2 已通过的歌词地图、翻译、循环、Rap、导航等整改，也不要把旧 R2 READY 再派发。**

连续执行「分析→最小修复→定向测试→真机验证→修复回归→更新证据/文档」，普通检查节点不要求用户发“继续”，但须遵守外部授权边界。

### 唯一优先队列

1. `P0 PDF`：修复 Android WebView `Blob → a[download]` 假成功，使用可用原生文件存储/分享链路；手机文件管理器可找到、外部应用可重新打开/分享才算 PASS。
2. `P0 A4`：核对手机与电脑两套 A4 排版来源；延续紧凑双栏和重复段右栏的设计，检查中文/韩文/英文、长歌词、字号、截断、黑白打印。宁可分页不丢字。不要擅自批量导出想学歌单。
3. `P0 MOBILE`：以授权 Note 11 5G 做 340/360/393dp、系统字号、横屏、安卓返回与地图弹层、断网缓存播放专项回归；模拟和真实结果分别标识，勿动其他手机。
4. `P1 PAPER`：隔离副本验证 JSON 修订/差异预览/确认回写/撤回；仅在已有授权的视觉模型可用时测试照片识别，否则标 BLOCKED、不新接收费服务。
5. `QA`：目标相关测试、TypeScript、Web/Android 构建，APK 版本号严格递增 `>26`，核对资源哈希及 About 版本；将结果按证据更新 HANDOFF/验收矩阵，明确 FAIL/OPEN/BLOCKED。

### 安全与完成口径

- 本轮授权的开发/调测机：**Redmi Note 11 5G**。Note 12T Pro 和 Note 12 Pro 未获本轮调测授权；此前 12T Pro 仅为一次性安装指令，不可沿用为本轮 QA 授权。
- 只允许操作 P040 的既有项目目录；严禁写别的项目、覆盖原始 MP3/LRC、已有人工作图/译文、已迁移正式库/real-qa 真实数据；数据库实验使用隔离副本。
- 未经额外明确批准：不重启现有真实服务、不 commit/push、不正式部署/发布、不自动批量导歌、不擅自调用未授权视觉云端模型、不复活音源分离。
- 仅在文件真实落盘、外部可打开/分享并有证据时宣称「手机保存 PDF 已通过」。`389 前端 + 260 服务端` 属于 R2 的 `1.1.22 (25)` 证据，不可冒称最新版测试。
- 用户本次批准的是 R3 **开发计划与本地 READY 交接**，本文件出现 READY 不代表 R3 代码已实现。
- GUI 转发：**不执行**。需要本人授权的事项集中一次说明，不阻断其余可做工作。

## 恢复入口

- 当期计划：`docs/plan/P040-A4-Mobile-Delivery-V1.3-R3.md`
- R2 验收：`docs/qa/evidence-2026-11-04-v13-r2/QA_RESULT.md`
- 既有交接：`docs/handoff/HANDOFF.md`
- R2 原任务归档：`docs/plan/P040-V1.3-R2-CURRENT_TASK-ARCHIVED.md`

当期任务唯一状态：**READY**。正式发布仍需用户独立签收。
