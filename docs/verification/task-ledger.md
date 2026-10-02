# 个人舞蹈曲库 V1.5 任务证据

基线：specs/001-personal-dance-library/plan.md 与 tasks.md V1.1。

## 初始检查

- ZIP CRC 通过；19 个可定位 manifest 项 SHA256 通过。压缩包根目录提示词文件名编码异常，未解压该项；使用 docs/plan/ 下用户提供的独立中文提示词文件。
- 已安全接入 .specify、specs、reference、assets 与相关 docs，未覆盖现有文件。
- 首批素材 31 MP4 + 31 MP3，同名配对 31，无缺项；文件存在与大小已查，媒体有效性待 ffprobe。
- USB Android 设备真实连接：indq5xfi6hovay4d，22101316C。
- 通道目录原始 Codex 输出只保留模型 slug，避免把模型内置提示词混入项目资料。
- Ruling：用户最新直接指令要求持续开发到 Human Gate，采用已提供 SDD V1.1 为实施基线；现有治理文件原地保留，不改中央规则。构建/安装/测试获本次开发范围授权，正式发布行为仍留最终 Gate。
- Ruling：缺失统一 preflight 脚本，用相同三通道只读目录查询核验实际所用模型，记录差异，未冒充 CHANNEL-OK。

任务未取得实际验证证据前保持未勾选；不得以自检意图替代完成证据。
