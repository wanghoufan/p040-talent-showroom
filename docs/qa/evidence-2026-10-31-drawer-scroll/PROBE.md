# 沉浸地图抽屉不可滚动｜修复与验证证据（2026-10-31，1.1.13）

- 关联缺陷：真机 QA（`docs/qa/evidence-2026-10-31-reference-phone/QA_RESULT.md` 同批 1.1.12 走查）——Redmi WebView 视口 393×791，抽屉顶 y=-846、底 791、高 1637，「载入这份参考」在 y≈-566，真实触摸与 `scrollIntoView` 都够不到。
- 根因：`src/styles/vocal-practice.css` 的 `.vocal-drawer` 把高度上限写成了 `max-height: 92dvh; max-height: 92dvh;`（两条都是动态视口单位，缺 `vh` 兜底）。该 WebView 丢弃 `dvh` 声明 → `max-height` 退成 `none` → 抽屉涨到内容高（真机 1637px）→ backdrop 是 `align-items:flex-end`，超高处向上溢出 → `clientHeight == scrollHeight`，`overflow-y:auto` 没有可滚余量 → 顶部按钮与波形永久落在视口外。
- 修复：改为 `max-height: 90vh; max-height: 90dvh;`（先 `vh` 再 `dvh`），并补 `-webkit-overflow-scrolling: touch`。上限收到九成视口，底部留出可点背景关闭的余量；**未改任何字号、未缩按钮、未改文案、未动安全区变量**；`modal` / `drawer` 两种呈现与吉他详情页均未改。
- 回归用例：`tests/unit/vocal-sheet-viewport.test.ts` 的用例表新增 `.vocal-drawer`（原先只列 `.vocal-sheet`/`.vocal-lyrics`/`.perform-lyrics`/`.import-sheet`，抽屉因此漏网）。

## 计算型复现（headless Chrome，非真机）

方法沿用 `docs/qa/evidence-2026-10-31-sheet-scroll/PROBE.md`：用 vitest/jsdom 渲染真实 `VocalPracticePlayer`（沉浸 → 点「地图」打开抽屉，内置参考 + 10 段候选 + 600 峰波形），把 `container.innerHTML` 落盘，再注入真实 CSS（`theme.css`＋`index.css`＋`vocal-practice.css`）用 Chrome 测量；**不手抄标记**。视口用 CDP `Emulation.setDeviceMetricsOverride` 精确设为 393×791（Redmi WebView 实测值），DPR 2。

四个变体（`before` 样式源＝修复前声明，`nodvh` ＝按解析失败丢弃所有 `dvh` 声明，模拟该 WebView）：

| 变体 | computed max-height | 抽屉 top/bottom/height | client/scroll | 可滚动 | 顶部时「载入这份参考」 | 顶部时波形 | 底部时「保存为人工结构」 | scrollIntoView 载入参考 | 输入滚动后 scrollTop |
|---|---|---|---|---|---|---|---|---|---|
| before-nodvh | `none` | -626.3 / 791 / 1417.3 | 1417 / 1417 | 否 | 不可点 | 不可见 | 可点 | **不可点** | **0** |
| before-dvh | `727.72px` | 63.3 / 791 / 727.7 | 728 / 1417 | 是 | 可点 | 可见 | 可点 | 可点 | 480 |
| after-nodvh | `711.9px` | 79.1 / 791 / 711.9 | 712 / 1417 | 是 | 可点 | 可见 | 可点 | 可点 | 480 |
| after-dvh | `711.9px` | 79.1 / 791 / 711.9 | 712 / 1417 | 是 | 可点 | 可见 | 可点 | 可点 | 480 |

- 「可点」＝目标中心点在视口内，且 `document.elementFromPoint(cx, cy)` 命中的就是该按钮或其子节点（触摸真正会落到它身上）。
- 本机探针内容高 1417 CSS px，真机为 1637；机制相同（内容高 > 视口，`align-items:flex-end` 向上溢出），故 before-nodvh 的抽屉顶为 -626.3 而非 -846。
- 「输入滚动」＝CDP `Input.dispatchMouseEvent{type:'mouseWheel'}` 连续 4×120px（走浏览器输入通道，不是 JS 改 `scrollTop`）。before-nodvh 为 0 说明该容器根本没有滚动余量；修复后为 480（= 内容余量上限内），说明滚动链恢复。
- 截图：`before-nodvh-top.png`（顶部标题、参考卡、波形全在视口外，首屏从段落 chip 开始）、`after-nodvh-top.png`（抽屉顶部 79px 处，标题/结构工作室/参考卡/「载入这份参考」/波形/段落 chip 依次可见）。原始数值见 `LAYOUT-RESULTS.json`。

复现命令（脚本在仓外 `.local/drawer-probe/`，可重跑）：
`npx vitest run --config .local/drawer-probe/vitest.probe.config.ts`（落盘 `dom.html`）→
`node .local/drawer-probe/probe.mjs '[{"name":"before-nodvh","stripDvh":true,"cssFrom":"before"},{"name":"before-dvh","stripDvh":false,"cssFrom":"before"},{"name":"after-nodvh","stripDvh":true},{"name":"after-dvh","stripDvh":false}]'`

## 用例级前后对照（同一复现条件）

- 修复后：`npx vitest run tests/unit/vocal-sheet-viewport.test.ts` → **20 passed**（5 容器 × 4 断言）。
- 把 `.vocal-drawer` 临时改回 `max-height: 92dvh; max-height: 92dvh;` → 新用例按预期失败：
  `缺少 vh 兜底：旧 WebView 会把 max-height 退成 none: expected undefined to be defined`；随后按原字节还原（还原前后 SHA256 均为 `1868a543c9728036ad0e6db910d4840b864d0d80ab0d1e279e9543ab603acc6f`）。
- 定向测试（未跑全量回归）：`vocal-sheet-viewport`＋`vocal-immersive-catalog`＋`vocal-structure-studio`＋`vocal-practice-player` → **62 passed / 4 files**。

## 构建核验（1.1.13 / 16 debug）

- `npm run build` → `tsc -b` 通过；`dist/assets/index-DIitD9pz.css` SHA256 `ac1750ecc3babef029132c0e2c18e40916c2b7cda98c1b8d96831c1469a0a7f2`，其中 `.vocal-drawer{…max-height:90vh;max-height:90dvh;…}` 在产物中可 grep 到（不是只改了源码、没进包）。
- `npx cap sync android` → `android/app/src/main/assets/public/assets/index-DIitD9pz.css` 同哈希 `ac1750ec…`。
- `./android/gradlew -p android assembleDebug`（`JAVA_HOME=~/android-toolchain/jdk-21.0.12.1+1/Contents/Home`）→ BUILD SUCCESSFUL。
- APK：`android/app/build/outputs/apk/debug/app-debug.apk`，14,100,273 bytes，SHA256 `142e9dfe07646e12ade3753b4229aaa2d3c37eb6ea76554ac727d267ef082d5d`；`aapt2 dump badging` → `versionCode='16' versionName='1.1.13'`，包名 `com.wanghoufan.dancelibrary.dev`，minSdk 24 / targetSdk 36。
- 从 APK 内解出的 `assets/public/assets/index-DIitD9pz.css` SHA256 同为 `ac1750ec…`，且含同一 `.vocal-drawer` 规则——即包内资源就是修复后的资源。

## 限制（不得据此宣称真机通过）

- 以上是 headless Chrome 布局引擎 + 输入通道计算，**不是** Redmi 的 WebView；真机仍需复测：打开沉浸 → 地图抽屉 → 顶部「载入这份参考」可点 → 滚到底「保存为人工结构」可点 → 波形可拖动分界 → 抽屉外背景可关闭。
- 同文件里仍有未加兜底的动态视口单位（本轮未改，未纳入修复范围）：`src/index.css` 的 `.app-shell{min-height:100dvh}`、`.shell__empty{min-height:65dvh}`、`.reference-video{height:65dvh}`。其中 `.reference-video` 在丢弃 `dvh` 的环境下高度会塌成 0，建议单独立项修。
- 本轮未操作手机、未播放声音、未访问或修改正式数据、未做音源分离、未跑全量回归、未 commit/push。
