# 真机验收：批量 20 首导入 + 歌词对齐 + 跳转

- 设备：Redmi Note 11 5G（`21091116AC`，Android 11，序列号 `WGBMXWDIAIFMPFCQ`）。**note11tpro（`IN9LZTAYV4UGU4JF`）全程零操作。**
- 包：`com.wanghoufan.dancelibrary.dev`，`versionName=1.1.6`、`versionCode=9`（未重装、未清数据、未卸载）。
- 服务：`node server/index.mjs`，`HOST=0.0.0.0 PORT=28794`，隔离库 `var/vocal-v31-work/real-qa-20261030/db/qa.db`，`VOCAL_IMPORT_WORKER=0`（只入库、不分离）。
- 操作范围：`am start` 前置 App、点按、滚动、截图、`uiautomator dump`、一次配对。**未改任何系统设置**（导航模式仍为 `navigation_mode=0`，未触碰输入法、亮度、无障碍）。
- 时间：2026-10-30 22:24–22:31。

## 结论

| 验收项 | 结果 | 证据 |
|---|---|---|
| 连接本地服务 | **PASS**：地址 `http://192.168.31.61:28794` 连接成功并保存 | `07-connect.png`（「连接成功，服务器地址已保存」） |
| 设备配对 | **PASS**：配对成功，配对码输入后生效（配对码不落盘、不进文档） | 库内 `owner_credentials` 由 2 增至 3 |
| 曲库读到新导入的歌 | **PASS**：导入卡片显示「已入库 31」，唱歌曲库出现 본批 20 首 | `10-vocal.png`、`16-lang-en.png` |
| 仅原唱口径 | **PASS**：歌曲页「原唱」可选、「伴奏（未提供）」灰显；曲库标「文本曲目」 | `11-song.png` |
| 歌词逐句显示 | **PASS**：时间在左、句序号在右，1→7 递增（0:03/0:09/0:14/0:18/0:25/0:29/0:35） | `12-lyrics.png` |
| 点歌词跳转（第 4 句） | **PASS**：点后进度由 0:00 变为 **0:18**，第 4 句高亮 | `13-jump5.png` |
| 点歌词跳转（第 7 句） | **PASS**：点后进度变为 **0:35**，第 7 句高亮 | `14-jump7.png` |
| 语言筛选（韩文） | **PASS**：韩文桶 4 首全为韩文（여름 안에서 / 소나기 / 흉터 / Bubble Pop!） | `16-lang-en.png` 前一次点击 |
| 语言筛选（英文） | **PASS**：英文桶为 Let Go / All Falls Down / Jar Of Love / Clean Bandit…（修正前这些被判中文） | `16-lang-en.png` |
| 播放出声推进 | **PASS**（22:36–22:37）：点「播放」后 0:00→0:08→0:24 连续推进，按钮转「暂停」；可见原唱轨正常出声 | `17-playing-8s.png` |
| 结构段跳转 | **PASS**：结构区列出 前奏 0:00 / 主歌 0:09 / 副歌 0:29 / 主歌 0:39 / 副歌 0:43 …；点「副歌 1:07」进度精确变为 **1:07** | `18-sections.png`、`19-section-jump.png` |
| 新包 UI：重复清单折叠 | **PASS**（22:45 覆盖安装后）：显示「▸ 歌词重复行清单：13 组（仅供参照，无需逐条确认）」默认折叠，不再出现「待确认 · unknown」 | `21-repeat-collapsed.png` |
| 新包 UI：标签冲突确认入口 | **PASS**：待核对卡点「核对歌词 / 伴奏」后，弹层给出「文件名一侧 / 音频标签一侧」对照 + 「歌名」「歌手」两个输入（默认填当前值），并写明保存即人工确认 | `20-conflict-input.png` |

## 覆盖安装（22:41）

- `npm run build` → `npx cap sync android` → `./gradlew assembleDebug` → `adb install -r`，**Success**；版本仍为 `1.1.6 (9)`（同版本覆盖，数据未清）。
- 装后验证：重复清单折叠、标签冲突歌名/歌手输入均生效（见上表末两行）。
- 首次点播放失败是因为坐标落在相邻「设置」按钮（`15-playing.png`），改按 1785 后一次命中。

## 未验 / 遗留

1. 「爱的恰恰」待核对卡片只打开弹层看字段，**未点保存**（保线程不变，留用户处理）。
2. `15-playing.png` 保留为误触记录。
3. 本轮未跑全量回归。

## 截图清单（`device/`）

`01-open.png` 启动停在旧会话详情页；`02-library.png` 未连接态；`03-me.png` 连接设置；`04-addr.png`/`05-addr2.png` 地址输入过程（输入法自动补全干扰，已恢复为保存值）；`06-me-reset.png` 重进页面后地址复位；`07-connect.png` 连接成功；`09-lib.png` 已连上（无「无法连接」提示）；`10-vocal.png` 唱歌曲库与导入卡片；`11-song.png` 소나기 详情（伴奏未提供）；`12-lyrics.png` 同步歌词与句序号；`13-jump5.png` 跳 0:18；`14-jump7.png` 跳 0:35；`15-playing.png` 误触练习设置弹层；`16-lang-en.png` 英文筛选。

## 设备状态已还原

- 删除设备临时文件（`/sdcard/qa08.png`、`ui*.xml`）。
- `adb reverse` 全部移除（`--list` 为空）。
- 输入法、导航模式、亮度、开发者选项均未改。
- 应用配对保留（供用户自行复验，不影响其它数据）。
