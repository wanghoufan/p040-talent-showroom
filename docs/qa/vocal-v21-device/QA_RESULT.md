# P040 Android 静音真机 QA（Redmi Note 11 5G）

日期：2026-10-30（Asia/Shanghai）  
结果：`BLOCKED_OS_PERMISSION`（正式用例未开始）  
范围：仅 Redmi Note 11 5G；不连生产数据库、不做全量测试。

## 设备与安全核验

- 独占身份：`codex-vocal-qa`；`devices` 显示 Redmi Note 11 5G 与 Redmi Note 12 Pro 在线，本次只锁定前者。此记录不保留设备序列号。
- 设备锁流程：`pin → status → resolve` 成功；每条 ADB 命令均使用解析目标的 `adb -s`。
- 音频只读结果：`dumpsys audio` 的 `STREAM_MUSIC` 显示 `Muted: true`、`streamVolume: 0`、当前扬声器路由索引 `0`。系统通用 `settings get system volume_music` 返回 `10`，但设备当前扬声器路由为零；没有尝试播放或触发声音。
- 未修改系统设置、未卸载应用、未清除数据。
- 安装前项目包查询未找到 `com.wanghoufan.dancelibrary.dev` 或 `com.wanghoufan.dancelibrary`，因此没有项目应用数据可覆盖。

## APK 核验

- 目标：`android/app/build/outputs/apk/debug/app-debug.apk`
- 应用 ID：`com.wanghoufan.dancelibrary.dev`
- 版本：`1.1.0 (3)`；SDK 目标 36；APK 为 debuggable。
- 签名：Android Debug；证书 SHA-256 `8e82a7975008e8ec87ff0f2ecadf495b5263effa34aaec9ab6f135ebea911cf3`。
- Manifest `allowBackup=true`。设备上原包不存在，本次未覆盖既有项目数据。

## 实际步骤与结果

| 步骤 | 操作 | 结果 | 证据 |
|---|---|---|---|
| 1 | 读取设备清单并用 `codex-vocal-qa` 锁定 Note 11 5G | 唯一匹配成功；Note 12 Pro 未操作 | 锁状态输出（不含序列号） |
| 2 | 只读读取 `STREAM_MUSIC`、包安装状态、设备预览画面 | 媒体流扬声器路由索引为 0 且 muted；项目包未安装 | `00-before-install.png` |
| 3 | 核验 APK 包名、版本、签名和备份标志 | 与目标 `1.1.0 (3)` 匹配；Android Debug 签名；`allowBackup=true` | 本报告中的 APK 核验记录 |
| 4 | 请求安装目标 APK（两次调用；第一次后 `pm path` 仍未发现包，第二次捕获到安装器回执） | 第二次返回 `INSTALL_FAILED_USER_RESTRICTED: Install canceled by user`；最终应用仍未安装。未绕过确认、未改设置、未卸载或清数据 | 安装器回执；最终 `pm path` 未发现包 |

## 未执行与限制

两次安装请求均未形成已安装包状态；第二次明确返回设备安装授权限制，按真机 QA 预检门禁停止。因此没有启动 P040、检查四个 Tab/已有数据/练唱或演出界面，也没有做离线或播放测试；不能据此判断这些功能通过或失败。未执行安装绕过或再次尝试。

预检能力结论：ADB 目标绑定与只读截图可用；应用安装权限未通过，最终门禁 `BLOCKED_OS_PERMISSION`。`00-before-install.png` 是安装前当前屏幕截图，不是 P040 应用画面。
