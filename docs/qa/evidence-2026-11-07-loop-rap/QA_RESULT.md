# QA 回执｜练唱页「Rap 框选 + 3/5 句 + 循环开始/结束」

- 日期：2026-11-07
- 版本：**1.1.31 (34)**（aapt2 badging：`versionCode='34' versionName='1.1.31'`，包名 `com.wanghoufan.dancelibrary`）
- APK：`android/app/build/outputs/apk/release/app-release.apk`（11 278 748 B）
  哈希 `a3853ce18c38d5bd512080c8b1955acc9d8043417f9693d745c526d85256620a`
- 前一版 1.1.30 (33)：11 278 660 B，哈希 `231550862b952875979ba2584c3cee7a111fa50501e8a1be8fa785f6ffe5cef1`（练唱三改本体）
- 执行方式：主开发者模式（本人实现＋本人判定；未派治理角色链）

## 一、改动清单（对应 4 条用户要求）

1. **跳过 Rap 改为按句框选**：点「跳过 Rap」直接弹出框选面板；第一下点某句＝开始句，第二下点另一句＝结束句，按这两句的起止时间跳过；不需要整首分段、不改歌词结构。范围存入 `practice.rapRange`，优先于「已确认 Rap 段」。面板含「将跳过 0:00–0:07」预览、始/终标记、重新开始/清除/关闭跳过/取消。
2. **2/4 句 → 3/5 句**：`LOOP_LINE_CHOICES = [3, 5]`，界面与设置面板同步替换，2/4 完全移除。
3. **删「自定义」「本段」**：`customRepeatLines` 及句数选择面板全链删除（类型、默认值、校验、存储、UI、测试）；服务端 `pickPractice` 过滤旧字段，旧记录保存不再报 `INVALID_PRACTICE`。
4. **「循环开始」「循环结束」区间循环**：起点＝当前高亮句（暂停取最近句，也可点歌词选句）；点「循环开始」按钮点亮，再点为取消；点「循环结束」设终点并从起点循环；循环中按一次＝停循环、继续往后播但保留起终点；再按一次＝清空起终点、按钮熄灭。循环期间抑制跳过 Rap 与整段/整首循环类冲突行为。

## 二、自动化验证

| 项 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | 通过（无输出） |
| 单元＋浏览器 | `npx vitest run` | 48 文件 / **397 用例全通过** |
| 集成（含歌词持久化） | `npm run test:integration` | **260 用例全通过** |
| 构建 | `npm run build` | 通过，APK 随之重出 |

关键回归用例（`tests/browser/vocal-practice-player.test.tsx`，47 条）含：按句框选不逼整首分段、3 句从前向夹取、同键二次退出、循环中不跳 Rap、切换 5↔3 句、区间范围上色与整框、practice 恢复含 `rapRange`。

## 三、装机与真机核对

| 设备 | 结果 |
|---|---|
| Note 11 5G `WGBMXWDIAIFMPFCQ` | `install -r` 保留数据；`versionName=1.1.30 versionCode=33` |
| Note 12 `indq5xfi6hovay4d` | `install -r` 保留数据；`versionName=1.1.30 versionCode=33` |
| 12T Pro `UKCESWB67PUO7LPB` | 同日补装：`install -r` 覆盖旧 1.1.28(31)，`versionName=1.1.30 versionCode=33`；残留 `.dev` 调试包已卸载 |

12T Pro 补装后当晚在同一台机上做了完整 UI 验收（见第四节），装包时未拉起 App 以免打断用户在淘宝的操作。

## 四、真机人工验收

### Note 11 5G（操作路径为练习页按钮，截图同目录）

| 截图 | 证明什么 |
|---|---|
| `vocal-detail.png` | 练习按钮组 3×2：跳Rap / 3句 / 5句 / 循环开始 / 循环结束 / 合练（无「自定义」入口） |
| `rap-picker2.png` | 点「跳过 Rap」直接开框选面板，含「先点 Rap 的第一句，再点最后一句…不改整首结构」 |
| `rap-picked.png` | 首句→末句选中，显示「始」「终」与「将跳过 0:00–0:07」 |
| `rap-bottom.png` | 面板底部「开始跳过 / 取消」可用 |
| `loop-start-end.png` | 点「循环开始」按钮点亮并提示「循环开始：第 N 句…；再点循环结束选终点」 |
| `loop-end-on.png` | 起终点两按钮同时点亮、模式文案「循环 · 第 1～1 句」、歌词区间整框高亮 |
| `font-reset.png` | 验收中误改的字号已复原「标准」，倍速已回 1× |
| `home-WGBMXWDIAIFMPFCQ.png` | 装机后首页正常、曲库在线 |

### Note 12T Pro `UKCESWB67PUO7LPB`（2026-11-07 当晚，1.1.30 实机操作）

| 截图 | 证明什么 |
|---|---|
| `12t-practice-buttons.png` | 打开《绿光》练习页，按钮组为 跳Rap / 3句 / 5句 / 循环开始 / 循环结束 / 合练 |
| `12t-rap-picker.png` | 点「跳过 Rap」直接弹「跳过 Rap：框选范围」，含「按这两句的起止时间跳过，不改整首结构」 |
| `12t-rap-picked.png` | 点第 1 句→第 2 句后显示「始」「终」、范围框与「将跳过 0:00–0:04」 |
| `12t-loop-start.png` | 点「循环开始」按钮点亮，提示「第 1 句…；再点循环结束选终点」 |
| `12t-loop-end.png` | 两按钮同时点亮，模式文案「循环 · 第 1～1 句（0:00–0:03）」、歌词区间高亮 |
| `12t-loop-play.png` | 播放 5 秒后进度仍回到 0:00，证明区间到终点自动回跳 |
| `12t-final.png` | 复原后：循环按钮全灭、倍速 1×、暂停在 0:00 |

12T Pro 的框选面板以「取消」关闭，未写入 `rapRange`，未改动该曲 practice 数据；循环为会话态，已清除。

## 五、未验证项（如实标注）

- **WebView CDP 不可用**：release 包未开 `WebContentsDebuggingEnabled`，`/proc/net/unix` 有 socket 但 `json/list` 为空，无法读 DOM；交互正确性主要由自动化用例证明，真机侧靠截图与坐标点按。
- **Note 12 未做 UI 验收**：设备锁屏（前台有音乐播放），按规则不擅自解锁；仅核对到版本号。
- 部分按钮点按坐标存在偏移，验收中曾误触倍速/字号，已逐一复原；不排除边角手势仍有偏差。
- 窄屏（340/360dp）、字号放大、横屏、返回栈等旧有未测项与本次改动无关，仍未测。

## 六、副作用与清理

- 误改的倍速 1×、字号「标准」已复原（`font-reset.png`）；区间循环为会话态，退出页面即清。
- 已 `adb forward --remove-all`；删除 28 张失败/噪声截图，仅保留上表 8 张。
- 旧构建产物：`android/app/build/outputs/apk/debug/` 已删；备份区 `var/backups/apk/p040-1.0.1-dev.apk`（11-03）仍在备份区未动。
- 未 commit、未 push。

## 七、1.1.31 (34)：提示区布局稳定性（A1 方案）

用户反馈：点倍速/循环后状态行凭空多一行，下方按钮行上下挪动（12T Pro 验收时同坐标误点到倍速即由此引起）。

- **做法**：状态槽 `.vocal-dock__mode` 固定 `height:20px` 常驻（空闲也占位、单行省略）；瞬时提示改为 `.vocal-toast` 浮层（`position:absolute`、`pointer-events:none`、4 秒自动消失），不参与文档流。
- **定位 bug**：`.vocal-practice.is-immersive .vocal-dock`（特异性 0,2,1）里的 `position:static` 覆盖 `.vocal-dock--immersive`（0,1,0），dock 不是包含块，浮层按视口算 `bottom:calc(100%+8px)` 被顶到视口外（无头 Chrome 实测 y=-46）。改为 `position:relative` 后实测 y=614.8（vh 791）、可见。
- **自动化**：`npx vitest run` 397 全通过（两处断言拆成分别校验状态槽与浮层）。
- **真机（12T Pro，1.1.31 实机操作）**：

| 截图 | 证明什么 |
|---|---|
| `12t-1131-practice.png` | 进入《绿光》练习页基线：按钮行与「自由练习」状态槽位置 |
| `12t-1131-rate-toast.png` | 点倍速出现「倍速 0.75×」浮层，按钮行 y 坐标与基线一致、未被顶动 |
| `12t-1131-toast-gone.png` | 4 秒后浮层自动消失，状态槽仍是「自由练习」，布局无回流 |
| `12t-1131-loop-start-toast.png` | 点「循环开始」出现三行提示浮层，按钮行位置不变、「循环开始」点亮 |
| `12t-1131-loop-end-toast.png` | 点「循环结束」两按钮同时点亮，状态槽换为「循环 · 第 1～1 句…」，按钮行仍原位 |

- 三台设备均 `install -r` 覆盖到 `versionName=1.1.31 versionCode=34`（Note 11 5G / Note 12 / 12T Pro）；Note 11 5G 与 Note 12 仅核对版本号，UI 仍为 12T Pro 单机验收。
- 12T Pro 验收结束时停在区间循环态（未继续复位）；循环为会话态，退出页面即清，未写 `rapRange`。
- 未 commit、未 push。
