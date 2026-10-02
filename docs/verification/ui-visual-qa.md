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

## 首页播放反馈复验（2026-10-02，接续开发）

- 固定 USB 真机 `IN9LZTAYV4UGU4JF`，型号 `22041216UC` / `xagapro`；未使用另一台 Note12 Pro。
- bundled debug APK 重建并 `adb install -r` 成功，保留 31 条曲库与 62 条离线缓存索引；页面源 `http://localhost/`，无 `server.url`。
- 原生 `adb shell input tap` 点击卡片播放：当前卡片蓝色封面边框、蓝色标题，独立按钮由 ▶ 变为 ⏸；底部固定播放条显示完整曲名、原生暂停控件、时间与进度。
- 点击同一卡片暂停：`audio.paused=true`，时间保持，卡片按钮回到 ▶，悬浮条继续显示当前曲名。
- 切换曲目：高亮仅有 1 张，标题跟随当前音频；滚动曲库后悬浮条仍为 `position:fixed`，位于底栏上方，不需滚到列表末尾。
- 截图：`screens/library-play-enhanced-playing.png`、`screens/library-play-enhanced-paused.png`；逐曲状态见 `offline-playback-round4.json`。
- QA 通道预检：设备识别、应用包路径、1080×2460 屏幕、WebView CDP 读取及 ADB 原生触摸/截图均通过。CDP touch 未触发实际点击，正式验证改用 ADB 原生触摸；未以脚本直接调用 `play()` 代替用户点击。


## 2026-10-03 批量分类与渐变封面合并复验

固定 note11tpro 原生触摸：批量勾选高亮、已选数量、底部分类按钮、弹层原生下拉三状态/标签操作、预览与取消保存均可用。隔离示范曲目验证增删替换与未选项不变；真实曲库只勾选/取消和播放，未测试写入真实分类。浅深渐变封面及详情舞名/水印显示正常。

截图：`screens/bulk-edit-sheet.png`、`bulk-edit-saved.png`（可清除示范）；`bulk-edit-real-selection.png`、`cover-bulk-home-light.png`、`cover-bulk-home-dark.png`、`cover-detail-dark.png`（最终合并 APK）。证据 `bulk-edit-round5.json`。
