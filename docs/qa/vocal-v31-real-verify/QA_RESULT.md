# P040 V3.1 严格伴奏校验 · 真实素材验证结果

- 日期：2026-10-30
- 范围：中文、英文、韩文三首已实际分离的真实原曲及其伴奏
- 被测实现：`server/vocal-import/accompaniment-verify.mjs`（未注入假 probe，使用默认真实 `ffprobe` / `ffmpeg`）
- 数据来源：`var/vocal-v31-work/reports/run-manifest.json`（真实分离运行报告）
- 结果文件：`var/vocal-v31-work/reports/strict-verification.json`
- 执行命令：`node var/vocal-v31-work/v31_strict_verify.mjs`
- 环境：macOS arm64 / Node v24.19.0 / ffprobe 9.0.1 / ffmpeg 9.0.1
- 结论：**3/3 通过，0 失败**

## 校验内容

每首歌曲均执行同一套严格校验：

1. 原曲文件存在，字节数与 SHA-256 与运行报告 `sourceBefore` 一致；
2. 伴奏文件存在，字节数与 SHA-256 与运行报告 `outputs` 一致；
3. 调用 `createAccompanimentVerifier()`（默认真实 probe）校验伴奏：
   - 扩展名为允许的音频格式；
   - 实际 SHA-256 与报告记录一致，且不等于原曲 SHA；
   - ffprobe 可识别且有时长；
   - ffmpeg 整轨解码无错误、覆盖率完整（`fullyDecoded = true`）；
   - 伴奏时长与原曲时长在容差内（取 2 秒与 2% 的较大值）；
4. 校验结束后再次计算原曲 SHA-256，确认整个过程中源文件未变化。

## 逐首结果

| 歌曲 | 语言 | 原曲时长 | 伴奏时长 | 时长差 | 容差 | 完整解码 | SHA 与报告一致 | 原曲未变 | 结果 |
|---|---|---|---|---|---|---|---|---|---|
| 宝石Gem,俞天时,王洋EVIS - 爱的恰恰 | zh | 194.717 s | 194.717 s | 0 ms | 3894 ms | 是 | 是 | 是 | PASS |
| 3LAU, Carly Paige - Touch | en | 205.773 s | 205.773 s | 0 ms | 4115 ms | 是 | 是 | 是 | PASS |
| Apink - 덤더럼(Dumhdurum) | ko | 208.053 s | 208.053 s | 0 ms | 4161 ms | 是 | 是 | 是 | PASS |

关键哈希对照：

| 歌曲 | 原曲 SHA-256（前 16 位） | 伴奏 SHA-256（前 16 位） | 两者不同 |
|---|---|---|---|
| zh-01 | `f49e42fbb510358b` | `0084d8f1203f28b7` | 是 |
| en-01 | `b76193882e06503d` | `e79414eeee86c048` | 是 |
| ko-01 | `8b7de7748240e40e` | `db07ab09bcc84ca7` | 是 |

## 结论边界（重要）

- 本验证只检查文件完整性、SHA、真实解码与时长一致性，**不评价人声分离音质或听感**；
- 三首歌曲均**未进行人工听感验收**，不得据此声称“音质合格”；
- 未合成音乐、未修改原曲或伴奏、未写入生产库、未操作手机；
- 未运行全量测试，未提交 / 推送代码。

## 证据

- 机器可读完整结果：`var/vocal-v31-work/reports/strict-verification.json`
- 真实分离运行报告：`var/vocal-v31-work/reports/run-manifest.json`
- 复跑脚本：`var/vocal-v31-work/v31_strict_verify.mjs`
