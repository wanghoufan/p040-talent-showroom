# P040 唱歌练习 + KTV 双音轨演出 · V2.1

## 如何使用

1. 解压完整 ZIP。
2. 双击 `P040-Vocal-Android-Interactive-V2.1.html`，在 Chrome / Edge 中打开。
3. 底部四个 Tab 分别为 **曲库 / 今晚节目单 / 演出模式 / 我的**；默认在曲库。可进入五首示例歌曲练唱，并通过「加入节目单」添加至演出清单。
4. 在「今晚节目单」试用排序、移出、加入、准备演出（演示资源内置，正式的 Android 离线缓存仍需开发）。
5. 在「演出模式」，默认伴奏，点击「原唱」可在同一位置切换、继续播放；点击下一首之后恢复伴奏，等待手动播放。
6. 「我的」及舞蹈、吉他在原型里仅作导航位置示意；正式开发必须继承当前 P040 的真实功能和数据。

## 文件说明

- `P040-Vocal-Android-Interactive-V2.1.html`：自包含可交互 HTML，离线打开即可播放五首示例的双音轨。
- `assets/{harbor,city,window,pulse,orbit}.mp3`：五首原创伴奏音轨。
- `assets/{harbor,city,window,pulse,orbit}-guide.mp3`：五首原创合成导唱旋律音轨，用于模拟 KTV 的「原唱」切换；**不是歌手真人演唱**。
- `assets/{harbor,city,window,pulse,orbit}.lrc`：逐句时间戳歌词。
- `P040-Vocal-SDD-Development-Plan-V2.1.md`：开发计划完整最新版，仍用原阶段组织并整合双音轨能力。
- `P040-Vocal-Main-Developer-Handoff-V2.1.md`：唯一主开发者完整交接说明。
- `V2.1-Performance-Mobile.png` 等：390×844 浏览器手机视口截图，**非 Android 真机截图**。

## 验证范围

- 已验证 HTML/JS 语法，Chromium 的手机视口下通过四 Tab、5 首样例、节目单、演出默认伴奏、演出中途切轨保留播放位置/播放状态、换下一首恢复伴奏并暂停、练唱详情与导航检查。
- 音轨示例采用人工标记的歌词和段落结构，**不代表 AI 已经完成实际歌曲分析**。
- 浏览器是在本地通过 `set_content` 装载 HTML 进行测试，因为当前系统阻止访问 localhost URL；没有作 Android APK 安装或实际生产数据验证。
- 未修改 Mac mini 上 P040 仓库，未动原有 31 首曲目、Git、生产数据库和手机应用。正式开发要先备份和做数据迁移验证。

## 与 V2.0 的关系

V2.1 保留 V2.0 的主开发者模式、Android 布局、四个底部 Tab、两行状态/语言标签、无 Rap 筛选、五首多语言演示、结构地图和逐句训练，新增 KTV 式双音轨和对原有今晚节目单/演出模式的完整升级要求。V2.0 的“节目单/演出仅占位”部分由 V2.1 替代。
