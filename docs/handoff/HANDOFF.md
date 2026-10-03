# HANDOFF｜P040 个人才艺曲库（舞蹈 / 吉他 / 唱歌）

更新时间：2026-10-03 12:39（Asia/Shanghai）。本文件是唯一当前快照；历史过程见docs/verification/completion-round7.md、completion-round8.md，最终验收口径见completion-acceptance.md。

## 当前范围与状态

- PROJECT_PHASE=DEVELOP。用户已批准003六阶段连续施工，亲自开发/测试/真机/交付，不派子智能体、不恢复ORCA编排、不重复阶段批准。
- 恢复业务基线main `ca2c3d8`。期间外部治理提交`ad131e9`已进入main，保留该既有提交，未由本轮修改中央规则。用户后续明确冻结吉他：保留已存在的代码、登记示例与QA记录，不继续开发或修改其数据。继续舞蹈、唱歌与公共功能；后续新增UI仅VOCAL，舞蹈选择角标修正限定非talent-grid。
- 舞蹈/唱歌/公共实现及本轮回归已通过。最新47个前端测试、43个后端测试、lint/tsc/build、Java21离线Gradle debug+unsigned release通过。真实固定手机已安装最终debug并冷启动，主资源`index-COCJ26op.js`、CSS`index-gQ6gbIDL.css`。
- 实现提交`8fd92c9`及交付回执`ce94c22`已推送main并核对远端。本轮未reset/clean，外部治理提交ad131e9完整保留。
- 正式签名、长期部署、公网点歌、首次发布签收保持Human Gate；旧T096仍OPEN，历史SC部分验收不改为PASS。本轮debug交付不等于首次发布签收。

## 实现与真机证据

|范围|有效验证|
|---|---|
|首页/筛选|标准/1.5字号、浅深到底、底栏与工具条；舞蹈场景AND；仅示例全选1、改变筛选选择归零；最终选择圈/标题/角标留白|
|唱歌UI|舞蹈同款卡内48×48小播放键；最终包真实触摸本地音频paused=false/time0.138413、手动暂停|
|资料与回收站|唱歌原调D/演唱调E/伴奏批量保存，示例恢复C/C/REFERENCE；QA原生取消删除/确认/恢复/永久记录删除|
|节目单/演出|混排真实拖动/上下移，24行纯文本、自滚动触摸暂停；物理断网冷启动本地音频/图片，切文本停音；最终原五首顺序与服务器一致|
|谱|隔离唱歌原生SAF PDF+PNG、多谱上移、640px图片、PDF2/2 canvas892×1263，解绑后原文件保留；此前PDF离线书签证据保留|
|离线/冲突|IndexedDB持久事务；采用Mac后续手机草稿算法回归；节目单连续排序revision推进及删除后排序无自身冲突，最终operations0/files0|
|文件队列|原生SAF2 selected，坏WAV独立失败、好WAV成功；隔离手机副本丢失明确提示且可清待办；网络失败/取消竞态/权限错误另有回归|
|示例|真实库保留三类三例五缓存；独立QA包+8793库原生清除/取消/普通对照保护/重导入3→0→3。隔离包已卸载、服务已关闭|
|点歌|只公开唱歌示例；小米原生图片扫码→手机Chrome点歌→App拒绝/关闭/历史清理，前轮接受加入通过；HTTP私人媒体/管理/限流/队列200保护|

最近修复：
1. 采用Mac版本只处理冲突那次操作，重放后续手机字段/标签草稿。
2. 文件移除等待当前处理结束；原生副本不存在可清待办，权限错误保留。
3. 连续节目单排序使用持久化最新revision、订阅节目变更。
4. 删除节目内曲目回传最终program与revision，手机持久化并保留后续本地移除，避免删除后继续排序自身冲突。真机加入14→删除15→上移16→下移17无冲突。
5. 唱歌首页小播放键；舞蹈批量选择圈、角标两侧预留标题空间。

## 数据保护与QA清理

- 真实31首DanceItem逐字段与本次恢复快照完全相同，全部active/会跳；**当前仅1首户外**，保留用户当前标签，禁止按旧快照“首首户外”回写。
- 原62缓存索引逐字段相同；手机62份实际文件大小和SHA256全部一致。现67=原62+登记示例5。备份仅存var/backups/，不入Git，不整体恢复覆盖用户修改。
- 三类登记示例active各一：DANCE `29abc681-e1fd-4edd-99d4-74b70591b8e6`；GUITAR `c906c3f5-da67-448b-b935-3960515340e5`；VOCAL `cbb0dbdb-77d5-45d8-9663-ae2db390a5dd`。唱歌C/C/REFERENCE及原创原歌词已恢复。
- 冻结吉他数据保持：登记示例revision9/Capo3，QA `84c64d55-0ee4-4c49-aeb5-014da8b6a1c9` / QA离线文件练习revision6/Capo0。**此QA暂留，不删除，不自动修改，等用户新方案。**
- 本轮唱歌QA `711233fe-a30f-45c9-bd18-17e80d337bc3`已前台永久删除，数据库无此记录；本轮追加节目项已移出。
- 原节目单五首顺序手机/服务器相同，revision17：`61f3bc6d-b3a3-44c3-984d-467b8d6f8c5c` → `bcbd6a34-c88c-49dc-9428-da1d5e75e67b` → `8cc971a0-3af7-477e-8b2c-1fa67a04e73b` → `80af63a6-9a0d-4a51-b7e4-be3aa4662fea` → `467358f4-7b14-4988-8bf8-f946c3a82301`。
- 仅已清本轮自制Downloads：P040离线收录验收.wav、P040-broken.wav、P040-score.pdf、P040-score.png、P040-扫码验收.png、P040-multi-good.wav、P040-multi-bad.wav及/sdcard/p040-window.xml。其他Downloads不动。

## 当前环境与最终包

- 固定note11tpro / serial `IN9LZTAYV4UGU4JF` / 22041216UC，禁止用其他USB/Wi-Fi设备替代。当前前台唱歌曲库、音频暂停、font_scale1.17、浅色、airplane0/Wi-Fi1。每次真机会话先adb devices及前台确认。CDP脚本先检查visible；后台DOM不算验收。用户允许正常声音，scrcpy必须--no-audio。
- dev包`com.wanghoufan.dancelibrary.dev`，Activity`com.wanghoufan.dancelibrary.MainActivity`。最后冷启动PID9939（后续重查，不照旧PID）；WebView端口9225按当前PID转发。
- 本项目开发API PID97825，原绑定0.0.0.0:8791；LAN http://192.168.31.42:8791。不是长期部署。8793隔离QA已关闭。重启先核实端口、cwd与命令，不杀其他项目。最新删除同步后端已加载。
- SQLite var/personal-dance-library.db，0004–0006迁移已加载。integrity_check=ok/foreign_key_check0。主人配对文件var/owner-pairing.json与手机dance.owner-token不得输出/提交。
- 最终debug：android/app/build/outputs/apk/debug/app-debug.apk，14,043,223 bytes，SHA256 `cc9eb72ea2037fcec97a1dd703dd22ce2425c62c4146115da57c0bac1b2ed259`；dev包名、Android Debug签名有效；已覆盖安装、冷启动实测COCJ26op。
- unsigned release：android/app/build/outputs/apk/release/app-release-unsigned.apk，11,192,738 bytes，SHA256 `e2b1d2ce3ea6c4dde28da4d841bcbd01f1fe035c9f6cf82a70d89c5708c02912`。未正式签名/未安装。
- 构建使用Java21/现有SDK/Gradle --offline；新PDF.js与QR依赖已锁版本与integrity，不重复下载。生成public/pdf、dist、android assets、APK、var、temp不入Git。

## 洁癖收尾（2026-10-03）

- 删除无唯一内容的旧AGENTS副本（逐字等于ca2c3d8中的AGENTS.md）、已停用的var/qa-isolated测试库/媒体/测试APK，以及var/qa-qrcode.json临时二维码；清理已合并的本地codex/personal-dance-library分支。真实库、媒体、备份、三类示例、冻结吉他记录与最终交付包保留。
- 修正回执待提交的过期状态；Human Gate文档改为当前验收边界与唯一快照/包证据指针；Android预览命令改用实际读取的HOST/PORT环境变量；双语README对齐离线批量编辑。
- 代码：verified-current（无业务源码修改）。运行态：verified-current（开发API健康检查；手机验收沿用本轮最终证据，本次不操作手机）。文档：changed-and-verified（本地链接与差异检查）。规则：verified-current（不修改中央规则；override软链有效，账本校验LEDGER-OK；GOVERNANCE-STATE保留治理迁移时历史统计，非当前产品进度）。记忆：not-applicable（无授权的独立记忆入口）。工作区：changed-and-verified（指定残留清除，备份与交付包hash不变）。

## 交付回执与下一步

- 2026-10-03：实现`8fd92c93be61432f4c84d366b5a742c9d94ed843`推送origin/main成功；远端ls-remote一致。最终包对应此实现，之后仅改交付文档，无业务源修改。
- 统一交付目录`var/交付/P040 才艺曲库丨2026-10-03`含调试APK、未签名发布APK、SHA256、交付说明；目录不入Git。调试APK复制后的hash与安装包相同。回执文档提交号以Git HEAD为准。
- 本轮继续范围的代码、测试、有效前台验收、指定唱歌QA清理、数据保护、debug打包安装与main推送已交付；**不声称首次发布验收已完成**。
- 下一步等待用户试用反馈；吉他保持冻结，收到用户新方案再续。旧T096/首次签收、正式签名、长期部署、公网点歌仍OPEN，不自动推进。

目标：本轮舞蹈、唱歌与公共功能已交付；吉他冻结。
剩 P0：无已确认P0；首次发布签收与旧T096仍OPEN。
下一步：等待用户试用反馈及后续吉他方案。
