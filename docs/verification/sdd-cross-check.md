# SDD Cross-check Report V1.1

## Result

当前没有阻断开发的 `NEEDS CLARIFICATION`。V1.0 中发现的歧义已通过本版默认规则消除。

## Findings fixed

1. **P038 source mismatch**：当前 Project Reader working tree 比远端落后且缺 app 源码；本版明确禁止从该过期 tree 盲拷，先定位 fresh origin/latest source。
2. **Android target drift**：旧 plan 未锁 current policy；本版固定 Capacitor 8 stable + API 36，避免 2026 Google Play policy 不合规。
3. **Touch target**：旧稿 44px 被修正为 Android 官方 ≥48dp。
4. **Splash**：不把设计稿的整屏启动页误当 Android 12+ system splash；系统 SplashScreen + 品牌首帧分层。
5. **Adaptive icon**：master 是视觉源，实际 Android 资源必须按 adaptive safe zone/monochrome 生成，避免双重 mask。
6. **UI vs SPEC 文案**：ImageGen 原型可能出现生成文字瑕疵；视觉结构看原型，精确 copy/业务看 SPEC。
7. **“收录”语义**：明确“收录舞蹈 = 来源视频/链接 -> 原视频 + 原音乐片段 + 歌曲信息 + 状态/标签”。
8. **原视频入口**：DETAIL 主操作固定“查看原视频”，不再缺入口。
9. **Light/Dark + ‘我的’**：用户已经确认两主题；本版让“我的”承担主题/连接/缓存，不引入账号系统。
10. **ADB preview**：加入 foundation 阶段 USB live reload，不把真机测试拖到结尾。
11. **APK prebuild**：Foundation 就构建/安装 debug APK，避免最后才发现 Gradle/native chain 断裂。
12. **Release signing**：连续开发不等于授权删除/卸载/改 keystore；debug `.dev` 包名隔离，最终 signing 留 Human Gate。
13. **Douyin safety**：不实现绕过平台限制的 generic downloader；adapter unavailable 时 PendingShare/本地视频补充。
14. **Copyright boundary**：prototype 示例封面/人物不打包，只使用用户媒体/来源截图/系统占位。
15. **Offline truth**：Ready 由真实文件 + size/hash/version 决定，杜绝现场“看起来下载了其实播不了”。
16. **项目 ID/包名**：本地 Project Steward 的 P 号不得猜；Android appId 固定 `com.wanghoufan.dancelibrary`，debug 使用 `.dev`，降低中途签名/安装冲突。

## Trace summary

- Constitution principles -> Plan gates: complete.
- 8 user stories -> Tasks phases 4–11: complete.
- FR-001..028 -> T026..095: covered.
- SC-001..010 -> automated/media/Android/UI evidence tasks: covered.
- UI approved assets -> T004/T005/T006/T012/T050/T083: covered.
- Android live preview/prebuild -> T014–T017 + T092/T093: covered.
