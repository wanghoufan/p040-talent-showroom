# 当前已验证 / 仍需由本地主开发者验证

| 子能力 | 隔离测试 | 正式工程集成 | Android 真机 |
|---|---|---|---|
| 旧单音轨角色迁移 | PASS（内存 SQLite） | NOT RUN | NOT RUN |
| 两音轨正确性/时长异常识别 | PASS | NOT RUN | NOT RUN |
| KTV 播放中切换/暂停保持/失败回退 | PASS（模拟播放器） | NOT RUN | NOT RUN |
| 中文、英文、韩文 LRC 解析 | PASS（五首样例 LRC） | NOT RUN | NOT RUN |
| 4 句循环、Rap 连段跳过、去 Rap 合练边界 | PASS | NOT RUN | NOT RUN |
| AI 导入结果结构与命名 | PASS（纯函数；无模型调用） | NOT RUN | NOT RUN |
| 真实双轨保存/曲库双列与两行筛选 | NOT RUN | NOT RUN | NOT RUN |
| 今晚节目单一键缓存原唱与伴奏 | NOT RUN | NOT RUN | NOT RUN |
| 演出模式默认伴奏/离线播放/切歌不自播 | NOT RUN | NOT RUN | NOT RUN |
| 实际 AI 从原唱分离伴奏/歌词配准 | 后续阶段 | NOT RUN | NOT RUN |
| P040 原 31 首及冻结吉他回归 | NOT RUN | NOT RUN | NOT RUN |

结论：当前完成的是 **V2.1 的底层开发首批可集成成果**，不能宣称 P040 V2.1 整体实现、APK 构建或生产交付。
