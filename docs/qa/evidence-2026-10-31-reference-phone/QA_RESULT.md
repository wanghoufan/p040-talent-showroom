# P040 指定手机 QA 记录（2026-10-31）

## 本轮范围与环境

- 设备：用户指定 Redmi Note 11 5G；独立 profile `codex-p040-qa`。
- 安装包：`1.1.11 (14)`，APK SHA-256：`dea04be9236d555cb053d37d8ee6bb635a4ad94bdd8d16cb62625cac896be9e1`。已覆盖安装并启动 `com.wanghoufan.dancelibrary.dev/com.wanghoufan.dancelibrary.MainActivity`；界面“关于”显示 1.1.11（构建 14）。
- 测试限制：未改手机系统设置；没有读取、复制或修改真实配对凭据。结构写入只发往本轮克隆库，未修改原库或源素材。
- 本轮临时隔离鉴权替身：新随机测试 token 仅以哈希写入克隆数据库；代理绑定本机 LAN 地址并只接受目标手机来源，剥除完整 query、丢弃传入认证头，仅透传非认证头并给隔离后端注入测试 token。代理不记录、输出或持久化传入凭据。该替身不是原服务鉴权验收。

## 结果

| 项目 | 结果 | 证据 / 说明 |
|---|---|---|
| 1.1.11 (14) 覆盖安装、启动、前台确认 | 通过 | `00-v111-launch.png`；安装包版本由 APK aapt 信息确认。 |
| 曲库点歌直达沉浸页 | 失败（现象复核） | 点选曲目进入“唱歌详情”，需额外点击“沉浸练歌”；见 `01-v111-papillon-before.png`、`03-v111-immersive-layout.png`。 |
| 沉浸页布局可见性 | 失败（现象复核） | 393×791 CSS px 视口；歌词区域下部被约 212 CSS px 固定播放器遮挡，截图中约 3 行完整、下一行部分遮挡；底部四 Tab 在沉浸页不可见。退出按钮可回详情，四 Tab 恢复；见 `03-v111-immersive-layout.png`、`04-v111-after-immersive-exit.png`。 |
| Papillon 候选与分歧标记 | 通过（克隆） | 结构室显示身份五项一致、10 段候选、2 段有争议。载入到参考草稿后，2 段仍为「待标注」；正式结构在保存前仍保持原 16 段。见 `07-v111-papillon-catalog.png`、`09-v111-reference-candidate-confirm.png`、`10-v111-reference-draft-loaded.png`。 |
| Papillon 波形分界拖动与撤销 | 通过（克隆） | 真实触摸拖动将前奏边界从 12.2s 改到 19.2s；点击撤销回到 12.2s。拖动时媒体保持暂停。边界圆点计数为 9。见 `10-v111-reference-draft-loaded.png`。 |
| 重复关系确认与人工结构保存 | 通过（克隆），文案缺陷 | B2 选择「旋律同、换词」后保存 10 段人工结构；重新打开后该按钮仍 `aria-pressed=true`。同一面板标题仍显示「与上一段 B1 的重复关系（待确认）」，与已选状态不一致。见 `11-v111-papillon-saved-clone.png`、`14-v111-repeat-relationship-saved.png`。 |
| 后续原唱分析不覆盖人工结构 | 通过（克隆） | 保存 10 段后运行一次原唱结构分析，草稿成功完成（10 段，用时 4.733s）；正式结构仍显示 10 段，未应用分析草稿。见 `12-v111-analysis-kept-clone-structure.png`。 |
| BABE 空结构播放头打点与保存 | 通过（克隆） | 初始结构 0 段、播放头 0s；点击「播放位置打点」创建 0–10s「待标注」段并保存，页面显示 1 段。全过程媒体暂停、未触发播放。见 `13-v111-babe-empty-marker-saved.png`。 |
| Let Go 错配候选阻断 | 部分可验证 | 打开 Let Go 结构室时没有提供 Papillon 候选，UI 未提供跨曲目错误候选可点；因此确认了该页面不会展示 Papillon 候选，但显式身份不匹配拒绝响应未测。见 `15-v111-letgo-no-wrong-reference.png`。 |
| 强静音 guard 下短时播放及整段循环 | 通过（静音状态验证） | 播放前已核验 guard、play 包装、AudioContext.resume 阻断；现存/新建媒体元素均强制 `muted=true, volume=0`。播放后 `currentTime` 前进且 muted/0 保持。0:00–0:12 循环中观察到 11.69s→4.13s、12.11s→7.42s 回跳；之后通过 UI 暂停。未做外部麦克风或声压测量。见 `17-v111-silent-loop-paused.png` 及本记录中的 guard/媒体状态。 |
| 真实服务连接恢复 | 通过 | 设置页“连接测试并保存”成功，endpoint 回到 `http://192.168.31.61:28794`；未重新配对、未读取 token。 |
| 测试静音 guard 清理 | 通过 | 恢复 endpoint 后强制停止并正常重启 App；当前与重载后均确认 `window.__p040Guard` 不存在、`HTMLMediaElement.prototype.play` 与 `AudioContext.prototype.resume` 为原生函数。媒体 paused=true、muted=false、volume=1。 |
| 隔离服务、测试凭据与映射清理 | 通过 | 临时服务 28796/28797 已停止；本轮自建转发 tcp:9226 已移除，未建立反向映射。临时 clone 目录（含测试凭据哈希）已删除。原服务 28794 仍监听。预存 tcp:9225 映射未动。 |

## 隔离接口阻碍

App 对 endpoint 使用 `validateEndpoint(endpoint, import.meta.env.DEV)`。当前安装包不允许 loopback，因此最初通过 `127.0.0.1` 连接失败。随后确认目标手机与主机在同一 LAN，改用本机 LAN 绑定、仅放行目标手机来源的临时代理；App 正常 UI 接入克隆成功，没有绕过 endpoint 校验，也没有向正式服务发测试写入。

## 清理与连接状态

- 原 endpoint 已恢复并通过应用连接测试；配对状态及原 token 未触碰。
- App 已重启，遗留静音 guard 已消失；媒体保持 paused、muted=false、volume=1。
- 临时后台进程、克隆库与本轮自建转发已清理；设备锁命令已确认释放 `codex-p040-qa`。预存 tcp:9225 映射未动。
- 终态截图 `18-v111-final-relaunch.png`；App endpoint 为原 28794，guard 不存在，页面重载后仍未恢复。

## 关键运行状态采样

- 波形拖动前边界：12.2s；触摸拖动后：19.2s；「撤销」后：12.2s。音频始终 `paused=true`。
- 保存关系后重新打开：B2 的「旋律同、换词」`aria-pressed=true`；标题仍为「与上一段 B1 的重复关系（待确认）」。
- guard 注入检查：`installed=true`、play 被包装、`AudioContext.resume` 被拦；尝试将现存及新建媒体设成 `muted=false/volume=1` 后，读取值仍 `muted=true/volume=0`。
- 播放前：`paused=true, muted=true, volume=0, readyState=4, currentTime=0`；播放约 2 秒后：`paused=false, muted=true, volume=0, currentTime=2.30`。
- 整段循环设为 0–12.2s；播放采样看到 `currentTime` 从 11.69s 回到 4.13s，之后从 12.11s 回到 7.42s；点击暂停后为 `paused=true, muted=true, volume=0`。
- 最终强停/重启与页面 reload 后：`guard=false`，play/resume 为原生实现，媒体 `paused=true, muted=false, volume=1`；endpoint 为原 28794。

## v1.1.12 (15) 真机定向复验（2026-10-31）

- 安装包：`android/app/build/outputs/apk/debug/app-debug.apk`，`1.1.12 (15)`；APK SHA-256 `e561ab3bceafa604fc905007c97f26bcde1c77e3512440bc145abb270d8b2c06`。aapt 包名/版本已核；安装成功并前台启动。设置页显示 `版本 1.1.12（构建 15）`。
- 使用隔离副本及 LAN 临时鉴权替身，未读取、复制或修改真实凭据；原库、源素材和手机系统设置未修改。

| 项目 | 结果 | 证据 / 说明 |
|---|---|---|
| 曲库点歌直达沉浸页 | 通过 | 点 Papillon 后 URL 为 `?immersive=1`，直接显示沉浸页，无需再按一次入口；见 `21-v112-papillon-direct-immersive.png`。|
| 返回与其他 Tab | 通过 | 「返回曲库」回曲库；今晚节目单、演出模式可由底栏进入。见 `24-v112-after-back.png`。|
| 歌词长列表真实滚动 | 通过（歌词容器） | 393×791 CSS px；触摸滚至 `scrollTop=7223.636/max=7224`，第 73 句完整显示且列表底边与播放器顶边相接，73/73 有中译；见 `22-v112-lyrics-bottom.png`。 |
| 播放器/底栏遮挡 | 失败 | 固定播放器在沉浸页占约 211 CSS px，覆盖底部四 Tab；歌词列表自身可滚到底且未被播放器截断。见 `21`、`22`。 |
| 播放器按钮可达及无声行为 | 通过（guard 验证范围） | 前进 10 秒与后退 5 秒可触；循环开关可切换；合练按钮可触。Papillon 无 Rap 区，跳过 Rap 控件 disabled。播放前核实强静音 guard；短时播放后暂停，采样媒体保持 `muted=true, volume=0`。未做外部声压测量，不能报告听感通过。 |
| 地图与结构工作室 | 部分通过 / 可达性失败 | 地图可打开结构工作室，但弹层超出视口：drawer rect `top=-846, bottom=791`、内容高 1637；「载入这份参考」按钮在 y≈-566。常规滚入及真实触摸滑动未能把候选按钮带入可视区。见 `23-v112-structure-studio.png`；因此候选一键加载未测。 |
| Papillon 波形拖动/撤销、B2 关系确认与保存 | 未测 | 因结构工作室内容超出视口、候选及控件无法通过原生 UI 到达，本轮未执行，未用样式/脚本绕过。 |
| 原连接、guard 与媒体终态 | 通过 | 设置页连接测试成功并保存原 endpoint `http://192.168.31.61:28794`；未重新配对、未读取 token。正常强停/重启后 `window.__p040Guard` 不存在，媒体 `paused=true, muted=false, volume=1`；设置页仍显示原 endpoint。见 `25-v112-restored-endpoint-restart.png`、`26-v112-guard-cleared-endpoint-original.png`。 |
| 临时资源与设备锁 | 通过 | 停止本轮代理；28796/28797 无监听；删掉本轮 clone/helper 目录；移除仅自建的 tcp:9226 映射，保留预存 tcp:9225；之后释放 `codex-p040-qa`。 |

**未覆盖：** B2 候选确认/保存、波形边界拖动与撤销、Papillon 一键载入、Let Go 显式错配拒绝。阻碍为工作室可视区域/滚动触控无法到达控件；这不是功能通过。未运行全量回归。

## v1.1.13（16）真机定向复验（2026-10-31）

### 环境和范围

- 指定 Redmi Note 11 5G，独立 profile `codex-p040-qa`；APK SHA-256：`142e9dfe07646e12ade3753b4229aaa2d3c37eb6ea76554ac727d267ef082d5d`。aapt 确认包名 `com.wanghoufan.dancelibrary.dev`、`1.1.13` / versionCode `16`；覆盖安装、启动与前台确认成功；“关于”显示 1.1.13（构建 16）。
- 测试服务使用独立克隆，仅含 Papillon、BABE、Let Go 三首及其必要媒体副本；未读取或复制原 `owner_credentials` 表。LAN 代理限制到指定手机来源，不记录请求/认证内容，并剥离传入认证头。原服务保持运行，本轮业务写入只到克隆。
- 获准执行真实媒体播放；未改手机音量或其他系统设置。

### 结果

| 项目 | 结果 | 实机证据 / 说明 |
|---|---|---|
| 覆盖安装、启动、版本核对 | 通过 | APK 元数据及“关于”页版本一致；`27-v113-launch.png`。 |
| 曲库点歌直达沉浸页 | 通过 | 曲目卡链接进入沉浸练歌页，无额外“沉浸练歌”按钮；`29-v113-immersive.png`。 |
| 歌词列表滚动与中译 | 通过（列表本身） | 393×791 CSS px；真实触摸滚至第 73 句，末句完整显示在播放器上缘；Papillon 73/73 中译、BABE 65/65 中韩、Let Go 54/54 英中。 |
| 播放器/底栏布局 | 部分失败 | 播放器控件均在视口内，`跳过 Rap`、`合练一遍` 标签完整；播放器顶部与歌词容器底部相接，没有截断末句。固定播放器仍覆盖底部四 Tab。Papillon 没有 Rap 结构，因此 `跳过 Rap` disabled。见 `33-v113-player-controls.png`。 |
| 地图抽屉真实触摸滚动 | 通过 | 抽屉位于 y≈79–791 CSS px、可视高 712；加载参考后内容可真实触摸滚动至波形、类型选择和保存区，没有 JS 改滚动位置或样式绕行。入口截图 `30-v113-drawer-top.png`；B2 段落截图 `31-v113-b2-saved-clone.png`、`32-v113-b2-loop-paused.png`。 |
| Papillon 候选/争议 | 通过（克隆） | UI 五项身份核验一致，10 段候选、2 段类型争议；一键载入后 U1、U2 保持「待标注」，保存前正式结构未改。见 `32-v113-b2-loop-paused.png`。 |
| 波形真实拖动与撤销 | 通过（克隆） | 真实触摸拖动前奏边界 12.2s→19.3s；点撤销回到 12.2s。操作时媒体暂停。 |
| B2 关系确认与保存 | 通过（克隆） | 选「旋律同、换词」后 UI 标题变为「与 B1 的重复关系（已确认：旋律同、换词）」；保存人工结构、重开并再次选 B2，仍显示已确认且选项 `aria-pressed=true`。数据库只写克隆。 |
| BABE / Let Go 错配路径 | 部分通过 | 两首结构工作室均明确显示「这首歌在本机没有已提供的参考」，Papillon 候选不出现；见 `35-v113-babe-no-papillon-candidate.png`、`34-v113-letgo-no-papillon-candidate.png`。没有从文件选择器导入错误候选，故身份不匹配文件的拒绝响应未测。 |
| 原唱真实播放 | 通过（媒体状态） | Papillon 原唱被选中；媒体 `readyState=4`、duration≈195.08s、`error=null`、`muted=false`、volume=1。一次真实播放采样约 4 秒由 79.87s 前进到 84.15s，后续暂停于 87.98s。 |
| B2 段落循环 | 通过（媒体状态） | UI 设置 B2 整段循环 79.9–103.3s 并点「试听」；媒体 `currentTime` 越过 103.4s 后回到该段内继续前进，随后通过暂停按钮停止。没有系统级音量修改。 |
| 合练按钮触控 | 通过（触控）；行为记录 | 真实触摸「合练一遍」后媒体从头自动播放，状态提示「合练中 · 自动跳过 Rap」；Papillon 的跳过 Rap 控件因无 Rap 段而不可用。之后按暂停并确认媒体 paused。 |
| 终态连接/媒体 | 通过 | 通过 App 设置页测试并保存原 endpoint，未重新配对、未读取凭据；强停/重启后 `guard=false`。回到原曲库打开 Papillon，媒体 `paused=true, muted=false, volume=1, readyState=4, error=null`，73 行歌词已加载。终态截图 `37-v113-final-original-paused.png`。 |
| 清理与锁 | 通过 | 临时代理停止；克隆库、媒体副本与 helper 删除；自建 tcp:9226 转发移除，预存 tcp:9225 未动；目标 profile 已释放。原 28794 服务未停止或修改。 |

### 限制与安全记录

- 播放状态、解码就绪和播放时间推进均由 WebView 媒体元素读回；当前控制通道不能监听手机扬声器，因此不报告听感或扬声器声学通过。
- 一次临时诊断输出曾包含带查询参数的媒体 URL（可能含配对参数）；未写入 QA 文件、克隆库或服务日志，代理未转发该查询参数。后续证据只保留媒体布尔/数值状态；**该值不记录、不复制、不外传**。真实配对状态未改。
- 只做本轮定向真机项目，未跑全量回归、未修改正式库/源媒体、未推送或部署。

### 交接结论（2026-10-31 09:10 收口）

**本次证据可支持**：安装与版本、点歌直达、歌词列表滚动与中译、抽屉真机触摸滚动、Papillon 参考候选与争议、波形拖动与撤销、B2 重复关系确认保存、隔离库内的播放推进与 B2 整段循环（仅媒体状态）。

**本次证据不支持（不得据此宣称）**：

1. 底栏四 Tab 仍被固定播放器覆盖（AC-PH13-04 FAIL）。
2. 扬声器/听感未验证：控制通道无法采集手机扬声器，全部结论只来自 WebView 媒体元素读回。
3. 五首真实人工听辨未完成；不报听辨百分比、不报“边界落在真实乐句线”。
4. BABE / Let Go 只证到“不显示 Papillon 候选”，**身份不匹配文件的 409 拒绝响应未测**（未从文件选择器导入错候选）。
5. 未部署到任何生产环境、未发版、未首发签收；本轮写入只到克隆库。
6. **（该条已失效，勿再当现状引用）** 原文「真实服务 28794 仍在运行旧接口集（进程 04:31:47 启动…），**切换/重启服务未获授权，未执行**」是 08:54 重启前的时点判断。实际已于 08:54 按用户 A1 授权重启为 pid 5164 并加载结构参考目录与波形路由（证据 `docs/qa/evidence-2026-10-31-service-restart-structure/EXECUTION-REPORT.md`）；真实服务侧的复验结论见下节。其余不支持项不变。

## 1.1.13（16）原服务复验与参考草稿载入（2026-10-31）

### 连接与只读参考检查

- 仍为 1.1.13（versionCode 16）；App 在原服务已重启后，经常规曲库导航重新打开 Papillon。WebView Network 回读到 `/api/repertoire` 200、音频 Range 请求 206；`fromServiceWorker=false`、`fromDiskCache=false`，本轮未使用临时替身或代理。
- 真实地图结构室首屏显示 Papillon / Jackson Wang，五项身份核验全通过，10 段候选、2 段类型争议；「载入这份参考」按钮和真实 SVG 波形均在视口内，波形边界手柄 15 个。未打开其他参考文件。截图 `38-v113-existing-service-reference.png`。
- 载入前以只读方式核查原库：Papillon 无 `vocal_structure_drafts` 行，正式结构 16 段。已审查当前实现：目录读取仅 GET 不写库；一键载入通过身份校验后只写 `vocal_structure_drafts`，正式 `repertoire_items.sections_json` 不改；组件状态显示候选未保存。项目定向用例也验证候选载入后正式结构字节不变。因此按授权仅在无旧草稿时点击了一次。
- 载入后 App 显示「10 段候选（未保存，正式结构不变）」、争议段仍「待标注」。原库只读回读：单独结构草稿 `DRAFT`、10 段、2 个 disputed/unknown、`DRAFT_REVIEW_REQUIRED`、`applied_revision=null`；正式 16 段结构哈希与载入前完全相同。未保存为人工结构、未确认任何类型或关系。截图 `39-v113-existing-service-reference-draft.png`。

### 播放与收尾

- 原唱模式真实播放前：`paused=true, muted=false, volume=1, readyState=4, error=null`，`guard=false`。点击 App 播放后约 3.5 秒，媒体时间从 0 推进到约 3.53 秒；随后点暂停，终态 `paused=true, muted=false, volume=1`，播放错误为空。见 `40-v113-real-service-original-paused.png`。
- 连接 endpoint 未更改；服务仍运行，真实媒体未静音。未改系统音量。此控制通道不能监听扬声器，故不作听感通过结论。
- 仅自建 CDP tcp:9226 映射已移除；预存 tcp:9225 未动。没有创建代理或临时服务；最终释放设备 profile。未跑全量回归。

### 当前状态与未完成（2026-10-31 09:02 更新）

- **服务**：`p040-vocal-lan-28794` 仍为 pid 5164（PPID 1、手动启动、无自启无自动重启），本轮未再重启、未改环境变量；`/api/health` 200。
- **数据**：`vocal_structure_drafts` 由 0→1，仅 Papillon 一条 `DRAFT`（10 段、2 段 disputed/unknown、`DRAFT_REVIEW_REQUIRED`、`applied_revision=null`）；正式 `repertoire_items.sections_json` 仍 16 段且哈希与载入前相同；媒体与生产库未变。重启报告 §6 的 `drafts=0` 是 08:54 重启时快照，**不是当前值**。
- **可核验证据**：`38-v113-existing-service-reference.png`（首屏身份/10 段/2 争议/波形）、`39-v113-existing-service-reference-draft.png`（载入后“未保存，正式结构不变”）、`40-v113-real-service-original-paused.png`（播放推进后暂停、未静音）；原库只读回读数值见上节。
- **仍未完成（不称完成）**：参考草稿逐段确认与应用、五首真实人工听辨、扬声器听感（控制通道无采集能力）、底栏四 Tab 遮挡修复、身份不匹配文件 409 实测、翻译 UI 手机端全流程、生产库迁移、首发签收。
- **不得宣称**：听感通过、结构已确认、已部署、已发版、已首发签收；也不得把本机 `DRAFT` 说成正式结构变更。

### 原服务 Papillon 原唱与候选 B2 整段循环（2026-10-31）

- **范围**：在原 28794 服务和既有 Papillon 参考草稿下，只通过 App UI 选择候选 B2 并播放；没有保存结构、确认类型或关系，也没有改 endpoint、配对或生产数据。当前用户草稿保留。
- **候选定位**：真实 UI 选中 `B2 · 副歌`，媒体定位至 `79.87s`，显示段界 `79.9–103.3s`。循环按钮点击后 UI 显示 `B2 整段循环：1:20–1:43`。截图 `42-v113-original-loop-active.png`。
- **循环与媒体**：28 秒逐秒采样见本轮工具输出：时间从 `98.02` 连续到 `103.02`，随后回到 `80.25` 并递增至 `101.27`，可确认至少一次按 B2 边界回绕。采样全程 `paused=false`、`muted=false`、`volume=1`、`playbackRate=1`、`readyState=4`、`networkState=1`、`seeking=false`、`error=null`；buffered 范围为 `0–120s`。原唱按钮 `aria-pressed=true`、伴奏 `false`。因此先前约 24 秒后显示 `80.35s` 是循环已从 103 秒回绕至约 80 秒，不是播放停滞。
- **音频输出证据边界**：播放期间 Android AudioManager 记录该 App 请求音频焦点；AudioFlinger 显示该 App 有 1 条 active track。`STREAM_MUSIC` 未静音，设备输出路由报告为 `speaker`。本控制通道不能直接监听手机扬声器，故只确认系统路由与媒体输出轨道，**不宣称听感/扬声器实际可听通过**。未改手机系统音量。
- **结束态**：之后通过 App 暂停，终态 `paused=true`、`muted=false`、`volume=1`、`readyState=4`、`error=null`、静音 guard `false`；截图 `43-v113-original-playback-paused.png`。最终页面歌词播放器显示 0:37、播放按钮，原唱被选中。原服务 health 检查正常，endpoint 保持原状。
- **清理**：只移除本轮 `tcp:9226` WebView 转发，保留既存 `tcp:9225`；未创建临时服务。结构草稿未保存或确认。
- **额外观察**：本轮长时采样后结构工作室弹层不再显示，页面回到普通歌词播放器（0:37）；未找到其关闭原因。播放器随后通过真实 UI 暂停。此现象单独记录，不据此推断草稿已保存；App 状态仍显示原唱选中。见 `43-v113-original-playback-paused.png`。
