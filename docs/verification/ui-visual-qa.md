# UI 视觉 QA（T083 / SC-008）

日期：2026-10-02（Asia/Shanghai）　设备：192.168.31.63:5555（Redmi Note 11T Pro+ / 22041216UC / xagapro，Android 14 / SDK 34）
APK：bundled 交付态 `app-debug.apk`（debug 签名）
对照 SSOT：`reference/ui/prototype-dark-approved.png`、`prototype-light-approved.png`

## 结论：层级 / 导航 / 男性化蓝黑视觉一致；无可爱卡通/粉色 chrome

真机关键屏截图与 approved 原型逐项人工核对：

| 核对项 | 原型（approved） | 真机（截图） | 结论 |
|---|---|---|---|
| 顶栏（标题 + 搜索 + ＋） | 有 | `library-first-batch-dark.png`：标题“我的舞蹈曲库”+ 搜索 + `＋` | ✅ |
| 顶部场景标签行 | 全部/耍酷/性感/户外/转场 | 同（AND 多选） | ✅ |
| 左侧状态栏 | 会跳/正在练/想学 | 会跳 0 / 正在练 0 / 想学 31 | ✅ |
| 卡片网格 | 封面 + 时长 + 标题 + 状态 | 31 张卡片，封面/时长/标题/“未识别” | ✅ |
| 底部四 Tab | 曲库/今晚歌单/演出模式/我的 | 同顺序，选中态高亮 | ✅ |
| 深色配色 | 背景近黑 `#060B12` | 截图取样一致（`#060b12`） | ✅ |
| 浅色配色 | 背景 `#F6F8FB`、surface `#FFFFFF` | `theme-light-settings.png` 一致 | ✅ |
| 男性化蓝黑 / 无可爱粉色 | 电光蓝 `#1677FF` 强调 | 按钮/选中态电光蓝，无粉/卡通 | ✅ |
| 系统状态栏跟随主题 | — | 见下（T083） | ✅ |
| 系统导航栏跟随主题 | — | 见下（T083） | ✅ |

截图清单：
- `screens/library-first-batch-dark.png`、`library-first-batch-light.png`（曲库双主题）
- `screens/theme-dark-settings.png`、`theme-light-settings.png`（“我的”双主题）
- `screens/theme-dark-bars.png`、`theme-light-bars.png`（系统栏跟随）

## 系统栏跟随主题（T083 复验）

修复 `ThemeBarsPlugin.java`（新增 `FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS`）后全屏 `screencap` 采样：
- 深色：状态栏 `(6,11,18)`、导航栏 `(6,11,18)`（= `#060b12`），见 `theme-dark-bars.png`（顶/底均黑）。
- 浅色：状态栏 `(246,248,251)`、导航栏 `(246,248,251)`（= `#f6f8fb`），见 `theme-light-bars.png`。

## 触控目标 ≥48dp（FR-023）

全仓核查 `src/index.css`：全局 `button,input,select{min-height:48px}`；`.page-header button`、`.scene-bar button`、`.status-rail button`、`.dance-card__body`、`.quick-play`、`.primary`、`.icon-link` 均 ≥48px。
本轮修复：`.playlist__handle` 44→48、`.playlist__move button` 40→48（均低于 48dp 的违规项。

## 边界

- 无像素级比对工具，采用人工层级/风格核对 + 取样，非自动化视觉回归。
- 正式签名与长期部署留 Human Gate。
