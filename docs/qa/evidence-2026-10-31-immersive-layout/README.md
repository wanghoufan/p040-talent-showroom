# 沉浸练歌布局核查（2026-10-31，v1.1.12 build 15）

## 这是什么

静态布局截图，用来证明「歌词区与播放器在视口中互不覆盖、按钮不再截断」。

**不是真机截图**：用 `.local/layout-check.html`（结构与 `VocalPracticePlayer` 沉浸态同一套 class）
加载真实的 `src/styles/vocal-practice.css`、`src/index.css`、`src/app/theme.css`，
在 Chrome headless 里按 390×844、360×800、740×360 三种视口渲染取图。
真机（WebView 字号缩放、系统栏 inset 实际值）仍需另行验收。

## 复现

```bash
# 390×844（iframe 固定 390 宽，规避 headless 最小窗口宽度）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --force-device-scale-factor=1 --window-size=410,880 \
  --screenshot=/tmp/frame.png "file://$PWD/.local/layout-frame.html"
magick /tmp/frame.png -crop 390x844+0+0 +repage docs/qa/evidence-2026-10-31-immersive-layout/01-immersive-390x844.png

# 360×800
... --window-size=380,820 --screenshot=/tmp/f360.png "file://$PWD/.local/layout-frame-360.html"
magick /tmp/f360.png -crop 360x800+0+0 +repage .../02-immersive-360x800.png

# 横屏 740×360
... --window-size=760,380 --screenshot=/tmp/fland.png "file://$PWD/.local/layout-frame-land.html"
magick /tmp/fland.png -crop 740x360+0+0 +repage .../03-immersive-landscape-740x360.png
```

## 结论（对照）

| 视口 | 歌词区 | 播放器 | 按钮文字 |
|---|---|---|---|
| 390×844 | 独立滚动，约 450px 高，第 4 句在播放器上方完整可见 | 底部卡片，约 200px，不覆盖歌词 | 重播/−5s/播放/+10s/循环、跳过 Rap/合练一遍/⚙ 设置/倍速 全部完整 |
| 360×800 | 同上，滚动到边界时按容器裁切（可继续滚） | 同上 | 同上，无省略号 |
| 740×360 横屏 | 左栏整列，可见 2 句 | 右栏纵向排列 | 同上，无省略号 |

未覆盖：真机 WebView 实际渲染、音频播放、系统返回键与手势。

## 不进 git 的输入

`.local/layout-check.html`、`.local/layout-frame*.html` 只是本地核查夹具，未纳入版本库。
