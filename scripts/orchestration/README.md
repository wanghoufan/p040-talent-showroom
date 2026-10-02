# scripts/orchestration｜L3 Watchdog（防停摆）

配套《Orca 通用编排者持续推进协议.md》的机械保险层（L3）。
编排者/监督者都是 agent，会死；这个定时器不会——它负责在编排停摆时自动唤醒协调者。

## `coordinator-watchdog-standalone.sh`（零配置，即拷即用）

- 只依赖 `orca` CLI + /tmp 日志，不依赖任何项目模板。
- 自动发现全部 Run，检测四类漂移：worker 终端失联 / dispatched 悬空超阈 / worker_done 长时间未消费 / 完成信号传输丢失。
- 漂移→往该 Run 登记的协调者终端发一条唤醒指令（同签名冷却 15 分钟防骚扰）。**只唤醒，不代做判断、不伪造工件。**

## 部署（macOS launchd，协议 §三十一：持久进程唯一正确姿势）

```sh
cp scripts/orchestration/coordinator-watchdog-standalone.sh ~/bin/ && chmod +x ~/bin/coordinator-watchdog-standalone.sh
# 注意 XML 定界符不带引号：写入时 $HOME 会自动展开为你的用户目录
cat > ~/Library/LaunchAgents/com.orca.coordinator-watchdog.plist <<XML
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.orca.coordinator-watchdog</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$HOME/bin/coordinator-watchdog-standalone.sh</string>
  </array>
  <key>StartInterval</key><integer>120</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
XML
launchctl load ~/Library/LaunchAgents/com.orca.coordinator-watchdog.plist
```

## 部署验证三件事（缺一即视为未部署，协议 §三十一）

```sh
launchctl list | grep coordinator-watchdog     # ① 可见
launchctl kickstart -k gui/$(id -u)/com.orca.coordinator-watchdog   # ② 手动触发成功
tail -5 /tmp/coordinator-watchdog.log          # ③ 日志出现评估记录（ok/no runs 均正常）
```

卸载：`launchctl unload -w ~/Library/LaunchAgents/com.orca.coordinator-watchdog.plist && rm 该plist`

## 可选环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `RUN_IDS` | 空=自动发现全部 Run | 只盯指定 Run |
| `STALE_EXEC_SEC` | 2700 | dispatched 悬空判定阈值 |
| `CONSUME_STALE_SEC` | 300 | worker_done 未消费判定阈值 |
| `COOLDOWN_SEC` | 900 | 同签名唤醒冷却 |
| `LOG`/`MARK`/`LOCK` | /tmp 下默认路径 | 日志/冷却标记/互斥锁 |

## 部署边界（与协议收编说明一致）

- 仅 **Orca 终端/外部通道编排长任务**时需要部署；本窗口 subagent 派工不需要（窗口不动你自然看得见）。
- watchdog 只唤醒，不做 Gate 判断，不得代写工件。
