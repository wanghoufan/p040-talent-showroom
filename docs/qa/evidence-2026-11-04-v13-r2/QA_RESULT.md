# V1.3-R2 整改与真机 QA（2026-11-04）

- 计划：`docs/plan/P040-Mobile-Lyrics-Experience-V1.3-R2.md`（用户 2026-11-04 批准）
- 版本：**1.1.22 (25)**，包名 `com.wanghoufan.dancelibrary.dev`
- 真机：**Note 11 5G**（adb `WGBMXWDIAIFMPFCQ`／`evergo`／`21091116AC`，Android 11）——用户 11-04 指定本轮唯一调测机；Note 12T Pro（`pearl`）本轮零操作。
- 设备环境：USB + 同一 Wi-Fi（192.168.31.226）；QA 服务为**隔离副本**（`/tmp/p040-qa-1104/qa.db`，从 real-qa 只读备份，副本内清空 `owner_credentials`），端口 28795，媒体目录指向 real-qa 只读媒体。生产库与生产服务未改动。

## 一、自动化

| 范围 | 命令 | 结果 |
|---|---|---|
| 前端全量 | `npx vitest run tests/browser tests/unit` | **47 文件 / 389 用例全过** |
| 服务端 | `npm run test:integration` | **260 用例全过** |
| 类型 | `npx tsc -b` | exit 0 |
| 构建 | `npm run build` → `npx cap sync android` → `assembleDebug` | BUILD SUCCESSFUL，APK 14,125,477 B，SHA-256 `3f8890ca…` |

## 二、真机逐项

| AC | 结果 | 证据 |
|---|---|---|
| AC-MAP-01 有分段/无分段都有明确 UI | PASS | 无结构曲目「风吹一夏」抽屉显示「这首歌还没有段落…播放位置打点／在末尾新增一段」，非空白（05） |
| AC-MAP-02 一击开、一击关 | PASS | CDP 触点：`aria-pressed` false→true→false，抽屉同步开合 |
| AC-MAP-03 断网/服务不可用不伪装「没有结构」 | PASS（代码＋文案） | 抽屉文案写明「服务不可用时会单独提示，不会当成没有结构」；服务不可用路径沿用既有 catalog 错误提示，未做真机断网复测 |
| AC-MAP-04 关地图不中断播放 | PASS | 播放中开关抽屉后 `currentTime` 未回零、仍为播放态 |
| AC-TR-01 中文歌不发翻译请求 | PASS（自动化） | 服务端 `translateSong(zh)` → `NOTHING_TO_DO`，translator 零调用；`summarizeTranslations(zh).missing=0` |
| AC-TR-02/03 外语逐行对应、无重复中文 | PASS | 真机英文歌 A4 稿「原文行 + 中文行」逐行配对；中文歌无「双语」按钮（真机确认） |
| AC-LRC-01～03 左时标右序号 | PASS | 沉浸页真机：左 `0:07/0:10…`、右 `1,2,3…`，点句定位与高亮正常（03） |
| AC-LRC-04 窄屏不溢出 | 待测 | 本机 1080×2400（≈393dp），340/360dp 与系统字号放大未实测 |
| AC-LOOP-01～03 同键二次退出 | PASS | 真机：2 句开启后 `currentTime=51.591s`；再点同一键 → `currentTime` 不变、`paused` 仍 true、`aria-pressed=false`、提示「已退出逐句循环，从当前时点继续」 |
| AC-LOOP-04/05 范围高亮 | PASS | 真机 DOM：`.vocal-line--loop-range` 命中第 11～12 两句，当前句另有 `.vocal-line--loop-current`（04） |
| AC-LOOP-06 暂停不自动播放 | PASS | 暂停态按键不触发 `play`（自动化＋真机 currentTime 不变） |
| AC-LOOP-07/08 档位互斥/无 LRC 禁用 | PASS（自动化） | 2↔4↔自定义只保留一档；无时标禁用并说明 |
| AC-RAP-01/02 真机可拖 | PASS | CDP 触摸拖动 SVG 分界：`pointerdown×1 / move×6 / up×1`，草稿段落边界时间随之改变（1:05→1:38） |
| AC-RAP-03 微调 | PASS | 抽屉内 9 个按钮：起点/终点 × ±0.1s/±0.5s + 对齐歌词行 |
| AC-RAP-04 保存重开不丢 | PASS（自动化） | studio 单测覆盖保存 payload 与重开状态 |
| AC-RAP-05/06 已确认才跳过、循环优先 | PASS（自动化） | 既有跳 Rap 用例全过；循环期间不抢跳 |
| AC-PRINT-01～03 A4 稿 | PASS | 真机：3 页、50 行、页眉「《Touch》· 音频版本 1 · 01lbohp1 · 机器参考」、备注栏、段标题+起止 |
| AC-PRINT-05 PDF 可打开 | PASS | 真机点「下载 PDF」→ 提示「已生成 3 页 PDF」；无错误态 |
| AC-PRINT-04 黑白打印 | 未测 | 需实际打印或在电脑端核对灰阶 |
| AC-PAPER-02 拍照识别 | **BLOCKED** | 无已授权视觉模型；面板明示走 JSON 通道，不做假识别 |
| AC-PAPER-03/04/08 冲突拒绝与差异预览 | PASS（自动化＋真机面板） | 真机面板显示修订号 `01mgznrg`、校验码 `01AZ`，与打印稿 `01lbohp1` 不同即会被拒绝 |
| AC-PAPER-05/06 快照与回滚 | PASS（单测） | 应用前自动快照，每首最多 10 份，可撤回 |
| AC-NAV-01～03 四底栏＋顶部演出 | PASS | 真机：底部 舞蹈/唱歌/吉他/我的，顶部 今晚节目单/演出模式（01） |
| AC-NAV-06 沉浸不遮挡 | PASS | 沉浸页底栏隐藏，歌词区直达播放器 |
| AC-NAV-04/07 返回栈/窄屏横屏 | 待测 | 需专项真机操作 |
| 离线：按需下载 | PASS（自动化）＋真机入口 | 真机曲库卡出现「下载这首歌 · 8.3 MB」；`onlyIds` 单测覆盖只下指定曲目 |
| 离线：断网播放 | 未复测 | 本轮设备未做断网；沿用 1.1.21 已验证链路 |

## 三、未完成 / 阻塞（需用户决定或补测）

1. **AC-PAPER-01/02（AI 视觉识别）BLOCKED**：需要已授权的图像理解模型与数据去向许可。当前只交付 JSON 导入 + 差异预览 + 确认回写 + 快照撤回。
2. **AC-LRC-04 / AC-NAV-04 / AC-NAV-07**：340/360dp、系统字号放大、横屏与安卓返回栈未在真机逐项走。
3. **AC-PRINT-04**：黑白实际打印未验。
4. **离线断网播放**：本轮未做断网复测（1.1.21 已通过，本轮代码未改播放链路）。
