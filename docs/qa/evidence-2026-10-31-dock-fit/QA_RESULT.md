# 沉浸练歌底部按钮「被挤压/覆盖」核查与修复（2026-10-31）

## 一、本轮做了什么

1. 按原型 `.local/ui-reference/练歌原型.png` 核对主页面（沉浸练歌）底部三排按钮与状态行「自由练习」的文字完整性。
2. 用**当前源码**重新渲染沉浸页 DOM（vitest + css 原样），在 9 个宽度下用 headless Chrome 量像素：
   按钮盒、文字实际绘制范围、是否越出按钮盒、是否压到相邻按钮、是否越出视口、字号下限。
3. 修 1 处真实缺陷（工具行五列等分放不下「⇄ 循环设置」），补 2 条针对性用例。
4. 逐项核对控件连线与人工结构保护，只跑相关定向测试。
5. 出包 1.1.14（构建 17）并核验产物。

**本轮不涉及**：真机操作、发声、真实曲库/原始音频、伴奏处理、commit/push、常驻服务。

## 二、缺陷与修复

### 2.1 现象（修复前，同一探针实测）

390×844（常见手机）、393×791（Redmi WebView 实测）、384×800 三个宽度下，
工具行第三行「⇄ 循环设置」的文字宽度约 78px，而五等分每列只有 67.6–69.4px：

| 视口 | 五列宽（px） | 「循环设置」按钮宽 | 文字实际范围 | 判定 |
|---|---|---|---|---|
| 390×844 | 68.8×5 | 68.8 | 86.8–164.6 | 文字越出按钮 10.0px，压到「1×」4.0px |
| 393×791 | 69.4×5 | 69.4 | 87.4–165.2 | 文字越出按钮 9.4px，压到「1×」3.4px |
| 384×800 | 67.6×5 | 67.6 | 85.6–163.4 | 文字越出按钮 11.2px，压到「1×」5.2px |
| 412×915 | 73.2×5 | 73.2 | 91.2–169.0 | 文字越出按钮 5.6px（未压到相邻按钮） |
| 428×926 | 76.4×5 | 76.4 | 94.4–172.2 | 文字越出按钮 2.4px（未压到相邻按钮） |
| 380 / 360 / 340 | 66.8 / 62.8 / 102 | — | 盒内 | 正常（≤380px 时装饰图标已隐藏） |

根因：`.vocal-immersive__tools` 用 `repeat(5, minmax(0, 1fr))` 五等分，且按钮 `min-width: 0`；
`white-space: nowrap` 让文字既不换行也不省略，只能原地溢出按钮盒、掠过相邻按钮背景。
381–430px 恰好是「图标仍显示（隐藏断点在 380px）」且「每列不够 79px」的区间，所以最常中招。

### 2.2 修复（`src/styles/vocal-practice.css`）

```css
.vocal-immersive__tools { display: grid; grid-template-columns: repeat(5, minmax(auto, 1fr)); gap: 6px; }
.vocal-immersive__tools button { min-height: 44px; padding: 4px 0; font-size: 15px; line-height: 1.15; white-space: nowrap; }
```

- `minmax(auto, 1fr)` + 去掉按钮的 `min-width: 0`：宽标签拿到自己的内容宽度，其余四列分剩余空间。
- 字号未改（仍 15px）、文案未改、未截断、未换行、未删图标；原型里的「⇄」装饰保留。

同一轮把底部状态行（`自由练习` / `合练中 · 自动跳过 Rap` / `逐句循环 · 第 N～M 句`）从 14px 提到 15px，
并删掉沉浸页重复的 14px 覆盖：它显示的是当前模式，不是可省略的元信息，按「其他正文类文本 ≥15px」执行。
8/18 组实测均未因此越出视口（`modeLine.rect.bottom ≤ vh`）。

### 2.3 修复后实测（同一探针，`layout-probe.json`）

| 视口 | 五列宽（px） | 「循环设置」按钮宽 | 文字范围 | 结论 |
|---|---|---|---|---|
| 390×844 | 66.0 / **79.8** / 66.0 / 66.0 / 66.0 | 79.8 | 84.0–161.9 | 盒内，无重叠 |
| 393×791 | 66.8 / **79.8** / 66.8 / 66.8 / 66.8 | 79.8 | 84.8–162.6 | 盒内，无重叠 |
| 412×915 | 71.5 / **79.8** / 71.5 / 71.5 / 71.5 | 79.8 | 89.5–167.4 | 盒内，无重叠 |
| 428×926 | 75.5 / **79.8** / 75.5 / 75.5 / 75.5 | 79.8 | 93.5–171.4 | 盒内，无重叠 |
| 384×800 | 64.5 / **79.8** / 64.5 / 64.5 / 64.5 | 79.8 | 82.5–160.4 | 盒内，无重叠 |
| 353×800 | 61.25 / **62.0** / 61.25 / 61.25 / 61.25 | 62.0 | 79.3–139.3 | 盒内，无重叠 |
| 380 / 360 / 340 | 66.8 / 62.8 / 102 | — | 盒内 | 无重叠 |

汇总（9 视口 × 2 状态 = 18 组）：`dockFitsViewport=true` 全通过、`buttonsBeyondViewport=[]`、
`textOverflowsBox` 0 处、相邻按钮文字/按钮盒重叠 0 处、按钮最小字号 15px、状态行 15px、
`documentElement.scrollWidth` 等于视口宽。修复前同口径为 10/18 组不合格（390/393/412/428/384 × 2）、状态行 14px。

证据：

- `layout-probe-before.json` / `dock-before-*.png`（修复前，由 `.local/before-css` 旧样式副本复现）
- `layout-probe.json` / `dock-immersive-*.png`（修复后）
- `probe.mjs`（只读探针；`CSS_DIR` 可指向旧样式副本，`PROBE_OUT`/`PROBE_THUMB` 改输出名）

## 三、控件连线与人工结构保护核对

| 控件 | 入口 → 真实逻辑 | 核对依据 |
|---|---|---|
| 上句 / 下句 | `goPrevLine` / `goNextLine` → `seekToLine` → `seekTo` 写 `audio.currentTime`；无时间轴时禁用并提示 | 用例「沉浸页上下句按歌词时间轴逐句定位」 |
| 2句 / 4句 / 自定义 | `startLineLoop(count,key)` → `lineLoopFor` 取句区间 + `seekTo(startMs,true)` 真播；`handleTimeUpdate` 到句尾回跳 | 新增用例（2句/4句）+ 原「自定义句数…」用例 |
| 本段 | `toggleSectionLoop(currentSection)` → `sectionLoop` 参与 `handleTimeUpdate` 回跳；再点退出 | 原「整段循环从段首播到段尾」+ 沉浸用例 |
| 合练 | `startJoint` → 归零播放、置 `skipRap`、关全曲循环，`handleEnded` 停 | 原「合练一遍从头播放…」+ 沉浸用例 |
| 分段（顶栏 + 标签条） | 顶栏按钮只显隐标签条；标签条 `jumpToSection` 定位并清循环，不改结构 | 原「分段按钮可收起段落标签条」「点歌卡直达」等 |
| 翻译 | `双语` 切显示；`更多` 里「翻译缺失 N 句」POST `/api/repertoire/:id/translations/translate`，失败按句回报 | 新增沉浸页翻译用例 + 原翻译用例（含通道不可用） |
| 字号 | `cycleFont` 三档改 `.vocal-lyrics--*`，`localStorage` 持久化 | 原「字号按钮切换歌词字号并记住」 |
| 循环设置 | 打开「循环与练习设置」弹层，改前后秒数/自定义句数/倍速并落同曲 `practice` | 新增用例（弹层六项齐全）+ 原设置用例 |
| 地图确认 / 保存 | 抽屉内「保存为人工结构」→ `validateSections` → `editLocally({sections})` → 全部标 `manual`；不点不改正式结构 | `vocal-structure-studio` 12/12（含「用户显式保存后才落库，且全部记作 manual」「抽屉只有一套标题」） |
| 旧人工结构保护 | 服务端拒收纯 algorithm 覆盖 manual（409 `MANUAL_OVERRIDE`）；分析遇 manual 段落跳过 | `tests/vocal-persistence.test.mjs` 7/7（含「人工结构不被静默覆盖」） |

## 四、定向测试结果（未跑全量回归）

| 命令 | 结果 |
|---|---|
| `npx vitest run tests/browser/vocal-practice-player.test.tsx` | **35/35 通过**（新增 2 条：2句/4句+循环设置+工具行文案完整；沉浸页翻译走真实接口） |
| `npx vitest run tests/browser/vocal-structure-studio.test.tsx tests/browser/vocal-immersive-catalog.test.tsx tests/browser/vocal-practice-translation.test.tsx` | **28/28 通过** |
| `node --test tests/vocal-persistence.test.mjs` | **7/7 通过**（临时库，不碰生产） |

新增用例锁住的不变式：工具行五个按钮文案恰为 `↺ 重播 / ⇄ 循环设置 / 1× / 双语 / Aa` 且不含省略号——
以后若为省宽度把标签缩写，用例会直接失败（像素宽度本身仍由探针量，不靠单测）。

## 五、出包核验（1.1.14 / 构建 17）

| 项 | 结果 |
|---|---|
| 版本真源 | `android/app/build.gradle`：`versionCode 17` / `versionName "1.1.14"` |
| `npm run build` | 成功；`dist` 内注入 `1.1.14` 与 `"17"` 各 1 处 |
| `npx cap sync android` | 成功，3 个插件正常 |
| APK 实际版本（aapt2 dump badging） | `versionCode='17' versionName='1.1.14'`，包名 `com.wanghoufan.dancelibrary.dev`（debug 后缀） |
| APK 内 `assets/capacitor.config.json` | 无 `server.url`；仅 `server.androidScheme=http` |
| dist ↔ APK `assets/public` 逐文件比对 | dist 205 个文件全部一对一命中；APK 多出 `cordova.js`、`cordova_plugins.js` 两个 **0 字节** Capacitor 占位文件（非 dist 内容） |
| 关于页注入 | 原生走 `App.getInfo()` → 读安装包 `versionName/versionCode` = 1.1.14 / 17；Web 兜底同值（构建期从 gradle 注入），两处同源 |
| APK | `android/app/build/outputs/apk/debug/app-debug.apk`，14,117,386 B，SHA-256 `c45537387ccadab3562be3b29b586856d6b1cb9da42d56669b4671b12547990a` |

## 六、未验收 / 未覆盖

- **真机未测**：本轮未碰手机。1.1.14（17）在真机上的安装、关于页显示、WebView 实际渲染（系统字号缩放、
  `--inset-*` 真值、厂商浏览器字体）全部 OPEN；上面的版式结论来自 headless Chrome 静态渲染。
- **未听感**：未出声，循环/合练/整段循环只证到媒体状态与回跳逻辑，不报听感。
- **未跑全量回归**：按指令只跑上述 4 个相关文件；其余模块未复测。
- **未提交、未推送、未部署**；未重启任何服务；未改真实曲库、原始音频与生产库。
