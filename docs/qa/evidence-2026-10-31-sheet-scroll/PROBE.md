# 结构校准弹层不可滚动｜修复与验证证据（2026-10-31）

- 关联缺陷：`docs/qa/evidence-2026-10-31-phone/QA_RESULT.md`「合并上一段 未测」——真机弹层高 1,138.8 CSS px、视口 791 CSS px、运行时 `max-height=none`，A2 按钮 y=-224 点不到，「与上一段合并」保持 disabled。
- 修复：`src/styles/vocal-practice.css` 的 `.vocal-sheet` 先声明 `max-height: 88vh` 再声明 `max-height: 88dvh`，并加 `overscroll-behavior-y: contain`。**未改任何字号、未缩小按钮、未改文案。**
- 回归测试：`tests/unit/vocal-sheet-viewport.test.ts`（按「引擎丢弃 dvh 声明」重放该规则）。

## 根因证据链

1. 出包当时 APK 内的 CSS 已含该规则，排除「打包打了旧 CSS」：
   `android/app/src/main/assets/public/assets/index-BrW9l4X8.css` 与 `dist/assets/index-BrW9l4X8.css` 同为
   `f9850a3e8826c1bf525c774ad4e874b08d71e095e7ab059817d9404db0724d05`，规则为
   `.vocal-sheet{...;max-height:88dvh;overflow-y:auto;...}`。
2. 真机 computed `max-height=none` ⇒ 该 WebView 不认 `dvh`，整条声明作废；`overflow-y:auto` 单独留着也没有可滚动余量（内容高＝元素高）。
3. `.modal-backdrop` 是 `align-items:flex-end`，所以超高的弹层向**上**溢出，顶部段落按钮落在视口外，无法滚动找回。

## 计算型复现（headless Chrome，非真机）

- 真实 DOM：用 vitest/jsdom 渲染 `VocalSectionEditor`（9 段、选中 A2），把 `document.body.innerHTML` 落盘，再注入真实 CSS（`theme.css`＋`index.css`＋`vocal-practice.css`）用 Chrome 测量；不手抄标记。
- 三个变体：`fixed-dvh`＝当前 CSS；`fixed-nodvh`＝当前 CSS 删掉所有 `dvh` 声明（模拟该真机 WebView）；`before-nodvh`＝再把 `max-height: 88vh` 兜底删掉（＝修复前 + 该真机）。
- 命令（在 `.local/sheet-probe/`，仓外临时目录）：
  `"Google Chrome" --headless=new --window-size=412,791 --force-device-scale-factor=1 --virtual-time-budget=3000 --dump-dom file://.../<变体>.html`
- 实测（视口 500×704，Chrome 对 `--window-size` 的换算；比例口径与真机 791 一致）：

| 变体 | computed max-height | 弹层顶 y | clientHeight / scrollHeight | 可滚动 | scrollTop=0 时首段按钮可点 |
|---|---|---|---|---|---|
| before-nodvh | `none` | -529 | 1233 / 1233 | 否 | 否（top=-405） |
| fixed-nodvh | `619.52px` | 84 | 620 / 1275 | 是 | 是 |
| fixed-dvh | `619.52px` | 84 | 620 / 1275 | 是 | 是 |

`before-nodvh` 与真机现象同型：`max-height=none`＋顶部被顶出视口＋滚动无效。

## 回归测试的证据

- 修复后：`npx vitest run tests/unit/vocal-sheet-viewport.test.ts` → 3 passed。
- 把 `.vocal-sheet` 临时改回只写 `88dvh`（保存前后 SHA256 均为 `2d476eaa1b08e5c9f9192343c3a74c927e2784f5e76516ce18779defcfec9e50`，改完原样还原）→ 该用例失败：
  `缺少 vh 兜底：旧 WebView 会把 max-height 退成 none: expected undefined to be defined`。
- 定向测试：`vocal-sheet-viewport`＋`vocal-structure-editor`＋`vocal-practice-player` → 28 passed。

## 限制（不得据此宣称真机通过）

- 以上是 Chrome 布局引擎计算，**不是**该 Redmi 的 WebView；真机仍需复测「拆一段→选上一段→合并→保存」闭环。
- 本轮未操作手机、未播放音频、未改生产库或真实数据。
