# 沉浸练歌对照原型整改：布局核查（2026-10-31）

## 这是什么

按 `.local/ui-reference/练歌原型.png` 整改 `VocalPracticePlayer` 沉浸态后的**静态布局核查**。
用 `react-dom` 真实渲染组件、导出 DOM，再套真实的 `src/index.css`、`src/app/theme.css`、
`src/styles/vocal-practice.css`，在 Chrome headless 里按 390×844 / 360×800 / 340×800 / 深色渲染取图。

**不是真机截图**：WebView 字号缩放、系统栏 inset 实际值、真实音频与手势仍需真机验收。

## 复现

```bash
# 1) 用临时 vitest 用例导出真实 DOM（用例不留在仓库）：
#    渲染 VocalPracticePlayer（?immersive=1）→ writeFileSync('.local/immersive-snapshot.html', container.innerHTML)
#    同样的 item 不带 ?immersive=1 再导出 '.local/detail-snapshot.html'
# 2) 套 CSS 生成 390/360/340/深色 四个页面，外面再套同宽 iframe（headless 有最小窗口宽度）
# 3) 截图并裁切：
for f in 390 360 340 dark; do
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
    --hide-scrollbars --force-device-scale-factor=1 --window-size=500,900 \
    --screenshot=/tmp/f-$f.png "file://$PWD/.local/immersive-frame-$f.html"
done
magick /tmp/f-390.png -crop 390x844+0+0 +repage .../01-immersive-390x844-light.png
magick /tmp/f-360.png -crop 360x800+0+0 +repage .../02-immersive-360x800-light.png
magick /tmp/f-340.png -crop 340x800+0+0 +repage .../03-immersive-340x800-narrow.png
magick /tmp/f-dark.png -crop 390x844+0+0 +repage .../04-immersive-390x844-dark.png
```

## 结论（对照原型）

| 视口 | 顶栏 | 段落标签 | 歌词 | 播放器 |
|---|---|---|---|---|
| 390×844 | 后退/歌名 23px/歌手 15px/分段/更多 全部完整 | A1 主歌、B1 副歌 chip，当前段蓝框高亮 | 段标题 + 横线分组，当前句整行胶囊高亮，原文 19px、译文 19px 灰 | 时间行 + 5 主控 + 6 逐句 + 5 工具，全部完整无截断 |
| 360×800 | 同上 | 同上 | 同上 | 工具行去掉装饰图标后「循环设置」完整显示 |
| 340×800（极窄） | 长歌名省略号截断，按钮不挤压 | 同上 | 同上 | 逐句行与工具行改 3 列两排，文字全部完整 |
| 深色 | 对比度正常 | 同上 | 同上 | 同上 |
| 740×360 横屏 | 顶部一行 | 左栏标签条 | 左栏整列滚动 | 右栏工具行 3 列，去掉装饰图标后「循环设置」完整 |

详情页（05）保持原四层播放器，歌词同样分组，时间/序号/纠错仍在原位。

## 未覆盖

真机 WebView 实际渲染、系统栏 inset 真值、音频播放与听感、手势与系统返回键。
