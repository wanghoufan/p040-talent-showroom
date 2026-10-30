# P040 Local AI Import V3.1 — usable prototype + full SDD

This ZIP is an **isolated handoff package**; do not overwrite the live P040 project with these files. It contains a **working conservative MP3/LRC scanner and optional local accompaniment extraction adapter**. It does **not** contain a trained AI model or the user's proprietary song files.

## 在 Mac mini 上最简单的验证

```bash
# 只扫描，不改歌曲文件。请把源目录替换成你在 Mac 上实际选择的目录。
python3 tool/p040_smart_import.py "/Volumes/三星/网易云音乐/音乐（用于转换）" \
  --report "/tmp/p040-import-preview.json" \
  --tasks "/tmp/p040-separation-tasks.json" \
  --output "/tmp/p040-extracted"

# 输出 preview，查看哪些自动匹配、哪些有歧义；下面这条也是只读计划检查。
python3 tool/run_separation.py "/tmp/p040-separation-tasks.json" --result "/tmp/p040-separation-dry-run.json"

# 单元测试（Python 标准库 + ffprobe/ffmpeg 测试样音）
python3 -m unittest discover -s tests -v
```

先用 `python3 tool/verify_real_samples.py --root "/Volumes/三星/网易云音乐/音乐（用于转换）" --report /tmp/p040-real-music-audit.json` 定向核对截图中的 8 组真实曲目。目录在 Mac mini 的外置卷上，当前交付环境并不能直接打开该盘。

扫描模式不需要安装 AI 模型，也不需要网络。上面第三条测试需要 ffmpeg、ffprobe；若本机没有，先安装即可。

## 真正运行本地 AI 伴奏提取（仅主开发者在 M4 预检后执行）

`audio-separator` 必须安装在**原生 Mac arm64 Python venv**；Mac 上先调用 `audio-separator --env_info` 和 `audio-separator --list_models` 确认加速及所选模型存在。模型权重可能需要首次联网下载。之后先用**一首真实歌曲**测试，再开启批量，别直接对几十首执行。

```bash
python3 tool/run_separation.py "/tmp/p040-separation-tasks.json" \
  --execute --max-jobs 1 --result "/tmp/p040-separation-one-result.json"
```

`--execute` 时才实际调用分离程序；输出与源目录严格隔离，不覆盖源 MP3/LRC。实际产品需补充持久队列、权限、数据库入库、音质听测与 Android 验收，见完整 SDD。

## 完成/未完成

- 已实现：安全扫描、Unicode/标点归一、音乐与 LRC 配对、重复 SHA 去重、不同版本保留、异常标记、LRC 多语时间戳解析、命令任务生成、默认不执行的本地模型 CLI 适配与状态报告；**31 项回归测试通过**。
- 未实现/未验证：模型首次安装/权重授权、实际人声分离性能与音质、Mac mini 真实目录读权限、P040 API/SQLite/App 集成、后台队列服务和真机音频 QA。这些由桌面唯一主开发者继续完成，不能假称已通过。

## 文件

- `P040-Local-AI-Import-Full-SDD-V3.1.md` — 最新全量开发计划，包含用户全部确定需求与验收项。
- `P040-Main-Developer-Handoff-V3.1.md` — 唯一主开发者完整接手口径。
- `tool/p040_smart_import.py` — 只读扫描 + 伴奏提取任务规划器。
- `tool/run_separation.py` — 本地人声分离任务运行器（默认仅 dry run）。
- `tests/test_smart_import.py` — 31 项自动测试，使用临时合成音频，不需要私有 MP3。
- `docs/QA-Results.txt` — 本次真实检查报告。

- `docs/Real-Music-Samples.json` — 用户截图中 8 组真实 MP3/LRC 的绝对路径关联、文件名和预期验收情况。
- `tool/verify_real_samples.py` — Mac mini 本地定向只读核对程序，不运行 AI 模型，不改源目录。
