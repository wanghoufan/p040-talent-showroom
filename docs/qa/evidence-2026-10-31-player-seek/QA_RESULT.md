# 练唱定位/显示层编号/版式与抽屉关闭键｜定向 QA（2026-10-31，1.1.15 构建 18）

范围：沉浸练歌的「定位到当前句」、段落编号显示层规范化、原文歌词字重行距、顶栏/播放器视觉、地图抽屉关闭键常驻、窄屏按钮不越界。
本轮**未碰手机、未出声、未改正式数据/原始音频、未做音源分离、未跑全量回归、未 commit/push**；QA 正在测旧包，`docs/qa/evidence-2026-10-31-*` 既有目录一律未动。

## 一、真机复现与根因

真机证据（既有，未改动）：`docs/qa/evidence-2026-10-31-prototype-phone-v114/13-0m44-after-top.png`。

现象：先把歌词滚回顶部，再把进度点到 0:44 —— 第 7 句 DOM 已是 `.vocal-line--active`，但停在 y≈579，被 y≈593 的播放器压住，`.vocal-lyrics.scrollTop` 仍是 0。

根因（`src/components/VocalPracticePlayer.tsx`）：滚动跟随的 effect 第一行是 `if (!playing) return;`。
- 暂停状态下点进度条/点句只改 `activeLine` 与 `timeMs`，从不滚动歌词容器；
- 只要暂停，当前句落在可视区底部就永远只露一半，看起来就是「被播放器挡住」；
- 播放入口虽然会滚，但每次换句都强制居中，用户手动往上翻会被拽回去。

修复：
1. `seekTo()` 每次显式定位递增 `seekReveal`；effect 只要发现这次是显式定位，就**不再看播放状态**，把当前句完整带进可视区（暂停时同样生效）。
2. 歌词区收到 `touchstart / pointerdown / wheel` 后关闭「播放跟随」，直到下一次显式定位再打开 —— 边播边读上一段不会被抢滚动位置。
3. 仍然只滚 `.vocal-lyrics` 容器本身，不动页面滚动。

## 二、复现证据（先失败，后通过）

新增 3 条用例（`tests/browser/vocal-practice-player.test.tsx`），断言的是**滚动几何**，不只是 `active` 状态：

| 用例 | 断言 |
|---|---|
| 暂停时定位到当前句也把整句滚进可视区 | 第 7 句 rect 相对容器顶 500、可视高 200；点句后 `scrollTop` 必须是 430（居中），且句子的相对 top ≥0、bottom ≤200；暂停时再 `timeUpdate` 不得改动用户滚动位置 |
| 手动滚动歌词后播放不再抢滚动位置 | 播放中手动滚到 600 后换句，`scrollTop` 必须仍是 600；再拖进度到 32s（第 9 句）才恢复跟随为 1190 |
| 旧结构 label 为类型名时显示层规范成 A1 主歌 | 地图/段标题出现 `A1 主歌`、`A1 · 主歌`；不得出现 `主歌 主歌`、`主歌 · 主歌`、`前奏 前奏`；未知类型仍为 `U1 待标注`；`item.sections` 对象与 label 原样 |

反证（把 effect 临时改回旧逻辑：`if (!playing) return;`）：
- 用例 1 失败：`expected 430, received 0` —— 与真机 `scrollTop=0` 完全一致；
- 用例 2 失败：手动滚到 600 后被自动拽到 1030。

复原后 `npx vitest run tests/browser/vocal-practice-player.test.tsx`：**38/38 通过**。

## 三、显示层编号（不写回持久化结构）

- 新增 `sectionHeading()`（`src/lib/vocal/structure.ts`）：编号与类型相同时只显示一份。
- 播放器内 `sections` 改为 `relabelSections(sortSections(item.sections))` 的**派生副本**：按类型与出现顺序重算 `A1 / B1 / P1 / C1 / R1`，前奏/尾奏用文字，未知 `U1 待标注`。
- `item.sections`、服务端字段、同步队列均未改动；保存结构仍只发生在「结构工作室」里用户点保存时。
- 段标签条、地图卡、歌词段标题统一走同一份编号；类型文案与编号相同时不再重复显示（于是 `前奏 前奏` 也一并消失）。

## 四、版式对照原型（`.local/ui-reference/原型与真机对照.png`）

| 项 | 原型 | 改前 | 改后 |
|---|---|---|---|
| 原文歌词 | 加粗，和译文有明显层次 | `font-weight:600`（真机看起来偏细） | `700` / `line-height:1.45` / 19px |
| 译文 | 常规字重、灰 | 19px 常规 | `400` / 1.45 / 19px（字号不变） |
| 行距 | 一对歌词更聚、段与段更疏 | 行内 gap 3、上下 padding 8 | 行内 gap 4、上下 padding 10（单句高 79.1px） |
| 段标签 | `A1 · 主歌`，比正文小一档 | 15px | 17px / 700 |
| 顶栏 | 标题左对齐紧接返回键 | 居中，长标题两头被挤 | 左对齐；23px/750、副标题 15px 单行省略 |
| 播放器 | 无描边浮层，只靠圆角与阴影 | 1px 边框围一圈 | `border:0` ＋ `0 -4px 16px #00000014` 阴影，18px 圆角不变 |

顶栏实测（headless Chrome，393/360/340/428）：标题与「分段」按钮**均不重叠**（393 下标题右边界 258 < 分段左 264）。

## 五、地图抽屉关闭键常驻

根因：抽屉只有一个滚动容器 `.vocal-drawer`，标题条（含唯一 `✕`）随内容滚走；滚到底部就没有关闭入口。

修复（`src/styles/vocal-practice.css`）：`.vocal-studio--drawer .vocal-map__head` 改 `position: -webkit-sticky; position: sticky; top: 0`，白底 + 下边线，仍**只有一个关闭键**（没有新增第二个 ✕）。旧 WebView 先认 `-webkit-sticky`；两者都不支持时退回原来的普通标题条，不会多出重叠控件。未引入新的 `dvh` 依赖。

实测（headless Chrome，把抽屉 `scrollTop` 拉到 `scrollHeight`）：

| 视口 | 关闭键数量 | 滚到底后位置 | 命中测试 `elementFromPoint` | 是否可见 |
|---|---|---|---|---|
| 393×791 | 1 | top 93.1 / bottom 137.1（滚动前后同值） | `BUTTON.vocal-map__close` | 是 |
| 360×800 | 1 | 94 / 138 | 同上 | 是 |
| 340×700 | 1 | 84 / 128 | 同上 | 是 |
| 428×926 | 1 | 106.6 / 150.6 | 同上 | 是 |

## 六、窄屏按钮不遮挡/不截断

同一探针量沉浸播放器三排按钮（transport / practice / tools）的文字绘制范围：

| 视口 | 文字越出按钮盒 | 按钮越出视口 | 相邻按钮盒重叠 | 最小字号 | `documentElement.scrollWidth` |
|---|---|---|---|---|---|
| 393×791 | 0 | 0 | 0 | 15px | 393 |
| 360×800 | 0 | 0 | 0 | 15px | 360 |
| 340×700 | 0 | 0 | 0 | 15px | 340 |
| 428×926 | 0 | 0 | 0 | 15px | 428 |

## 七、构建与产物核验（1.1.15 / 18）

| 项 | 结果 |
|---|---|
| 版本真源 | `android/app/build.gradle`：`versionCode 18` / `versionName "1.1.15"` |
| `npm run build` | 成功；`grep` dist 得 `1.1.15` 1 处、`"18"` 1 处，无 `1.1.14` 残留 |
| `npx cap sync android` | 成功（JDK 21，3 个 Capacitor 插件） |
| APK 实际版本（aapt2 badging） | `versionCode='18' versionName='1.1.15'`，包名 `com.wanghoufan.dancelibrary.dev` |
| APK 内 `assets/capacitor.config.json` | 无 `server.url`，仅 `server.androidScheme=http` |
| dist ↔ APK `assets/public` | dist 205 个文件全部命中且内容一致；APK 多出 `cordova.js`、`cordova_plugins.js` 两个 0 字节占位 |
| 新 CSS 是否进包 | `index-CIXvh_pW.css` 在 dist 与 APK 内 SHA-256 相同（`006d696b…`），且包含本轮新增的 `.vocal-studio--drawer .vocal-map__head` |
| APK | `android/app/build/outputs/apk/debug/app-debug.apk`，14,105,157 B，SHA-256 `a3c5f1da9b55420fd64bb067574bc6c30729ed51c844fd1bfa995489f380cda7` |

## 八、未覆盖 / 未验收（不得当 PASS 引用）

1. **真机未测**：未安装 1.1.15(18)，未在手机上验证定位滚动、字重、抽屉 sticky、`--inset-*` 真值与系统字号缩放 —— 全部 OPEN。
2. **未出声**：定位/循环只证到媒体与滚动几何，不报听感。
3. 未跑全量回归；只跑 `vocal-practice-player` 38 项 ＋ `structure-studio / immersive-catalog / practice-translation / unit-vocal` 50 项。
4. 抽屉 sticky 在极端旧内核（不支持 sticky）时退回顶部常驻之外的旧行为；本机 WebView 实测通过，旧内核未实测。
5. 波形拖动、真实手势滚动、安全区真值仍沿用此前 OPEN 结论。

## 九、证据文件

- `01-immersive-393.png` / `02-immersive-340.png`：改后沉浸页（字重、行距、顶栏、无描边播放器、段标签 `A1 主歌`）
- `03-drawer-bottom-340.png` / `04-drawer-bottom-393.png`：抽屉滚到底部后 ✕ 仍在
- `verify.json`：四视口原始测量值；`verify.mjs` ＋ `dump.probe.test.tsx`：只读探针与 DOM 快照生成脚本
