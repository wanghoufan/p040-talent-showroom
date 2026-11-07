# P040 V3.2 孤立实现 QA（2026-10-30）

## 已完成（当前容器真实执行）

- `node --test tests/structure-map.test.mjs`：**36 PASS，0 FAIL**。覆盖 A/B/P/C 编号、没有音频结构不造段、旧 LRC 不强定主副歌、候选重复不冒充确认、Rap 确认限制、按句拆/合并、关系引用不悬空、手动保存才允许导出 P040、纯函数无网络/音频 IO、不能覆盖原数据。
- `python -m unittest discover -s tests -p 'test_*.py' -v`：**1 PASS，0 FAIL**。用自制 18 秒 WAV 的重复片段在本地用 `librosa`/`chroma_cens` 对比，按相似度输出 pending-confirmation，入音前后 SHA 字节未变；**不是用户真实歌曲，也不证明旋律识别质量**。
- `python tests/browser_smoke.py`：**PASS**。Chromium 390×844 单列手机视口，覆盖点 B1、设置/取消循环、歌词起点不能拆、歌词中部可拆、恢复、明暗主题、四 Tab 可见、无 JS 异常。
- `node src/cli.mjs --analysis fixtures/example-analysis.json --lrc fixtures/example.lrc --duration-ms 180000 --out fixtures/example-map-output.json --song-id example`：**PASS**。输出示例 `前奏, A1, P1, B1, A2, B2, C1, B3, 尾奏`，0 个覆盖空缺告警。其结构时间轴是人为编写的示例，并非真实模型预测。
- 浏览器初始因为容器对 file URL 的管理限制无法加载，采用 Playwright `set_content()`；并修复在 opaque origin 访问 localStorage 报错的问题；复验 PASS。
- 测试发现合并/改类型可能导致 `repeatOf` 指向被删段落：已补重绑/撤销不兼容关联逻辑，额外新增 3 项回归，最后 36/36 PASS。

## 当前没有做、不得宣称已做

1. 尚未在用户的 Mac mini M4 上安装或试跑结构模型；更没有对五首真实歌曲完成乐段/重复关系准确性 A/B 评价。
2. 不能通过只读 Mac connector 修改 P040 仓库、数据库、已有 APK 或手机；当前交付代码位于隔离目录，不是 P040 生产/开发分支的真实提交。
3. 没有新增伴奏、人声分离、云端音频上传；未触用户真实 MP3/LRC。
4. Web 交互预览没有实际播放 MP3，也没有调用 P040 的 `seekTo`/离线队列；正式接入要在桌面主开发者环境进行。
5. 本包 `direct_mix_similarity.py` 只计算声学/和声相似性，不能证明同旋律。实际 A1/B1/C1 类型需要真实模型或人工校正。模型有默认 demix 的调用路径本轮禁止运行。

## 交接下一步

按照 `P040-Structure-Map-Complete-SDD-V3.2.md` 的 T0–T8 继续主开发者模式：保护工作树→替代旧歌词误分类路径→真实混音分析→草稿入库→播放器与编辑器集成→五首真实歌误差审查→定向真机验收。没有全部 AC 证据时不得标“正式 APP 已完成”。
