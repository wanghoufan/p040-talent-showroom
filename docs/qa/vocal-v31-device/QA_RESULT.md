# P040 真机 QA：APK 1.1.4 (7)｜Touch 导入扫描

日期：2026-10-30（Asia/Shanghai）

## 本轮结果

- **覆盖安装与版本：PASS。** `adb install -r` 返回 `Success`；PackageManager 确认 `versionName=1.1.4`、`versionCode=7`。从 `1.1.3 (6)` 升级，首次安装时间和应用数据目录保持不变；未清数据、卸载或更改系统设置。
- **四个底部 Tab：PASS。** 曲库、今晚节目单、演出模式、我的均在真机上正常打开。
- **测试环境隔离：PASS。** 服务进程实际打开 `var/vocal-v31-work/device-qa/qa.sqlite`；唯一本次登记的导入根目录规范化后指向 `var/vocal-v31-work/device-qa/music`。worker 未启用，扫描不会自动提取。扫描前 QA 数据库 `owner_credentials=0`、`vocal_import_jobs=0`；测试目录仅有 Touch 的 MP3/LRC 副本。未访问生产数据库或媒体目录。
- **连接与配对：PASS。** 临时服务连接测试成功，配对后应用成功读取唯一测试根目录。未连接时页面显示清晰的本地服务连接提示。
- **歌曲与歌词匹配：PASS。** 扫描结果为音频 1 个、歌词 1 个、新增任务 1 个；数据库记录的曲名 `Touch`、艺人 `3LAU, Carly Paige`、MP3 路径和 LRC 路径均对应测试副本，解析到 50 条定时歌词。未读取、复制或记录歌词正文。
- **候选确认状态：部分 PASS，需区分任务状态。** 任务卡显示 13 组歌词重复候选，标为“待确认 · unknown”，没有自动选定这些候选。与此同时主扫描摘要为“可自动提取 1 首、需核对 0 首”，任务状态是 `PENDING_EXTRACT / EXTRACT`，不是任务级 `NEEDS_REVIEW`。导入 worker 已关闭，所以任务停在待提取，未提取、未入库。
- **操作范围：** 仅连接测试、配对、读取根目录/任务列表和一次测试根目录扫描；未同步曲库、未导入/删除用户数据、未播放音频。扫描后保留了独立 QA 数据库中的这一条待提取测试任务，便于核对。
- **恢复与清理：PASS。** 已恢复连接前备份的原 localStorage；本轮生成的配对凭据按私有指纹精确删除，QA 数据库 `owner_credentials` 最终计数为 0。配对码未写入聊天、报告或截图，配对码文件未改动。ADB 转发已移除，设备绑定已释放。临时 QA 服务仍由任务负责人管理。

## 本轮截图

保存在 `docs/qa/vocal-v31-device/evidence/`；未包含歌词正文、配对码或令牌：

- `v1.1.4-library.png`、`v1.1.4-tonight-playlist.png`、`v1.1.4-performance.png`
- `v1.1.4-import-unpaired.png`、`v1.1.4-import-roots.png`
- `v1.1.4-scan-summary.png`、`v1.1.4-touch-review.png`

---

# P040 真机复验：APK 1.1.3 (6)

日期：2026-10-30（Asia/Shanghai）

## 本轮结果

- **安装与版本：PASS。** 覆盖安装 `adb install -r` 返回 `Success`。PackageManager 确认 `versionName=1.1.3`、`versionCode=6`；升级前为 `1.1.2 (5)`，`firstInstallTime` 未变，应用数据目录保持不变。未清数据、卸载或更改系统设置。
- **四个底部 Tab：PASS。** 曲库、今晚节目单、演出模式、我的页面均在真机上打开并正常显示。曲库提示服务器不可用并显示本地空库。
- **未连接时导入错误：PASS。** 本地智能导入显示“无法连接本地服务，请检查服务器地址与网络后重试”，目录列表提示加载失败；不再显示 `Unexpected token < in JSON`，也未复现 `AbortSignal.timeout`。
- **临时连接及配对：PASS。** 临时 QA 服务健康检查返回成功；页面连接测试成功。使用临时 QA 配对完成后，导入根目录列表显示一个已登记、可选的目录。截图只显示目录标签和 rootId，不含本机绝对路径。仅读取根目录与任务列表；未点“扫描并入队”，未执行曲库同步、导入或删除。
- **恢复：PASS。** 连接前保存了本机 WebView localStorage 私有快照，确认原来没有保存的 API 地址或 owner token。测试后从快照恢复原 localStorage（1 个 key，owner token 仍缺省）；本轮新建的唯一临时 QA 配对凭据按其私有指纹精确删除，数据库 `owner_credentials` 最终计数为 0。临时配对令牌和配对码没有写入报告或截图，配对码文件未改动。
- **播放器：未验证。** 本地曲库为空，QA `music` 与 `media` 目录均无文件；未播放声音，也未虚构听感。
- 设备锁与 ADB 转发均已释放/移除。临时 QA 服务仍由任务环境运行，供任务负责人按需关闭。

## 本轮截图

保存在 `docs/qa/vocal-v31-device/evidence/`：

- `v1.1.3-library.png`
- `v1.1.3-tonight-playlist.png`
- `v1.1.3-performance.png`
- `v1.1.3-import-unpaired.png`
- `v1.1.3-import-roots.png`

---

# P040 真机复验：APK 1.1.2 (5)

日期：2026-10-30（Asia/Shanghai）

## 本轮结论

- **覆盖安装：PASS。** 对 `com.wanghoufan.dancelibrary.dev` 执行 `adb install -r` 返回 `Success`。安装前为 `1.1.1 (4)`，安装后 PackageManager 确认为 `1.1.2 (5)`。`firstInstallTime` 保持不变，`lastUpdateTime` 更新，应用数据目录相同；未清数据、卸载或修改系统设置。
- **启动及四个底部 Tab：PASS。** 曲库、今晚节目单、演出模式、我的四页均实际打开并正常渲染。曲库仍提示服务器不可用，显示本地曲库空状态。
- **本地智能导入：FAIL（错误已变化）。** `AbortSignal.timeout is not a function` 本轮未复现；现在页面报 `Unexpected token < in JSON at position 0`，并提示目录列表加载失败、稍后可刷新任务。任务状态也显示同一错误。故本地导入仍不可用，当前证据指向接口返回了非 JSON 内容（这是从 JSON 解析错误推断，未直接检查网络响应正文）。
- **连接限制：** 页面显示“最近同步：尚未同步”；设备配对码为空、配对按钮不可用。曲库页显示“当前无法连接服务器，已显示本地曲库”。
- **播放器：未验证。** Android 文件选择器“最近”明确显示“无任何文件”，曲库也无可播放曲目。未播放或报告听感；未写入、删除用户文件。
- 结束时已释放本轮设备绑定。

## 本轮截图证据

截图存放于 `docs/qa/vocal-v31-device/evidence/`：

- `v1.1.2-library.png`
- `v1.1.2-tonight-playlist.png`
- `v1.1.2-performance.png`
- `v1.1.2-local-import-status.png`
- `v1.1.2-file-picker.png`

---

# 历史记录：APK 1.1.1 (4) 真机 QA

日期：2026-10-30（Asia/Shanghai）

## 结论

- **覆盖安装：PASS。** Note 11 5G 执行 `adb install -r` 返回 `Success`；系统确认 `versionName=1.1.1`、`versionCode=4`。未清除应用数据、未卸载任何应用、未修改系统设置。
- **启动及四个底部 Tab：PASS。** 应用正常启动；曲库、今晚节目单、演出模式、我的页面均可打开并渲染。
- **本地导入入口：部分 PASS。** 曲库“+ 收录舞蹈”入口可打开；手动音频/封面选项能进入 Android 文件选择器。文件选择器显示“无任何文件”，未选取或导入文件。
- **本地智能导入：FAIL。** “我的 → 本地智能导入”页面显示 `AbortSignal.timeout is not a function`，目录列表未加载成功，任务状态出现同一错误。
- **播放器音频：未验证。** 当前曲库和文件选择器均无可用真实曲目/音频；因此未播放，也不报告听感。需要提供真实歌曲或设备上可用音频后补测。

## 设备与数据安全

- 目标设备：Redmi Note 11 5G（本报告不记录设备序列号）。所有手机命令均经本次身份锁定，并显式指定解析目标。
- APK 包名：`com.wanghoufan.dancelibrary.dev`。
- 覆盖安装命令：`adb -s <locked-target> install -r android/app/build/outputs/apk/debug/app-debug.apk`，结果 `Success`。
- 安装后 PackageManager 报告：`versionName=1.1.1`、`versionCode=4`，数据目录为应用私有目录。未执行 `pm clear`、卸载或任何设置变更。
- 操作结束后已释放本次设备绑定。

## 证据

现场截图保存在 `docs/qa/vocal-v31-device/evidence/`：

- `library.png`：曲库初始页面及空库状态。
- `tonight-playlist.png`：今晚节目单页面。
- `performance.png`：演出模式页面。
- `settings.png`：我的页面和本地智能导入入口。
- `local-import-status.png`：本地智能导入错误与任务状态。
- `import-entry.png`：曲库收录入口。
- `file-picker.png`：Android 文件选择器及无可用文件状态。

## 遗留

1. 历史版本 1.1.1 的 `AbortSignal.timeout` 问题在 1.1.2 上不再复现；当前 1.1.2 的导入错误为 `Unexpected token < in JSON at position 0`，需修复后再复验。
2. 在有真实歌曲/音频文件时补测播放器播放、暂停与音频输出；没有可用歌曲前不虚构听感。
