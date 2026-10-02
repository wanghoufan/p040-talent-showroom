# UI Contract

## Navigation
- Bottom tabs: `曲库 / 今晚歌单 / 演出模式 / 我的`.
- “我的”仅承载主题、Mac Mini 连接、缓存/存储与关于；无账号系统。

## Library
- Top scene filters: `耍酷 / 性感 / 户外 / 转场`, multi-select AND.
- State rail: `会跳 / 正在练 / 想学`, single-select.
- Header `+` opens `收录舞蹈`.
- Card play button quick-plays PerformanceClip; card body opens detail.

## Import
`收录舞蹈` 的含义必须直接说明：把来源视频/链接变成 `原视频 + 原音乐片段 + 歌曲信息 + 状态/标签`。

## Detail
Primary actions at same visual level: `播放音乐` and `查看原视频`.

## Performance
Large transport controls; no edit/delete/reference-video controls; ended does not autoplay next.

## Visual
- Dark approved is primary: black/deep navy + electric blue.
- Light uses same hierarchy via tokens.
- No cute/cartoon/pink UI chrome.
- Prototype imagery is illustrative only and must not ship.
- Exact copy comes from SPEC, not OCR.
- Tap targets >=48dp.
