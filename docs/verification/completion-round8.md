# 完整化续验记录（2026-10-03）

固定USB note11tpro / IN9LZTAYV4UGU4JF；用户允许正常声音，scrcpy无音频转发。沿用ca2c3d8工作区增量，未reset/clean。用户恢复授权commit/push main与debug覆盖安装；随后要求冻结吉他，不再开发或修改其数据。

## 本次修正

1. 采用Mac冲突版本仅撤销该次操作，重放后续手机草稿与标签操作，并更新下一操作的baseRevision。新增冷启动与后续同步回归。
2. 待处理文件删除等待处理任务结束；副本丢失明确失败，可移除待办。原生文件不存在错误允许清待办，权限错误保留待办。新增丢副本、网络失败、取消竞态及权限回归。
3. 唱歌首页改用舞蹈同款卡内三角播放键，48dp触摸区，不另占一行；只改VOCAL分支，吉他按钮保持现状。
4. 真机触摸脚本先检查WebView前台visible，后台不发送触摸。背景DOM不作为前台验收证据。

## 已取得前台证据

|对象|步骤/实测结果|状态|
|---|---|---|
|唱歌紧凑卡片|安装CB3wSJOp资源版本，唱歌三角按钮48×48 CSS px，浅色截图vocal-inline-play-light.png|PASS|
|真实扫码|App只公开唱歌示例→小米原生扫码器图库识别自制二维码→Chrome打开同网地址→点歌成功→App待处理1→拒绝→0→关闭会话→清已处理历史0。采用图片扫码，不冒充摄像头对屏扫码|PASS|
|混排排序|真实触摸拖动第6项唱歌到第5项；上下移操作后恢复原五首顺序|PASS|
|歌词自动滚动|QA续验纯文本24行，scrollHeight1082、滚动开始后scrollTop1.45；真实触摸文本后aria-pressed=false|PASS|
|物理断网|airplane=1/Wi-Fi关闭，Active default network none；force-stop/cold-start。本轮期间其他App抢前台，失败轮不算通过；切回后重测|PASS（有效轮）|
|离线混排与图片|演出第6项唱歌：本地_capacitor_file_音频paused=false/currentTime0.257，谱图naturalWidth640；切第7项纯文本立即paused=true，播放禁用，24行歌词可读|PASS|

截图：screens/completion/vocal-inline-play-light.png、phone-qr-guest.png；其他截图须先确认前台确为本项目再归档。原五首顺序与真实数据需清理后最终核对。

## 数据保护与待办

- 恢复时真实舞蹈31首均active且会跳，**当前仅1首户外**；与旧交接“首首户外”不符。按当前数据库保护，不改回旧标签。保护快照仅存var/backups/resume-protected-dances.json，不入Git。
- 原缓存62+示例5=67，升级后仍67；最终逐项比对尚待手机独占验收。
- 只临时编辑唱歌示例长歌词，已恢复原歌词。新建VOCAL QA `711233fe-a30f-45c9-bd18-17e80d337bc3`（QA续验纯文本），须精确清理。
- 吉他现有QA `84c64d55-0ee4-4c49-aeb5-014da8b6a1c9`按用户冻结指令保留，待新方案，不借清理改动吉他。
- 手机反复被切到地点日记；已请求独占时段。前台检查拦截后台触摸，无效轮未作为验收。
- 原生多谱解绑/排序、唱歌专属批量字段、舞蹈场景AND与大字号选择圈、隔离原生示例清理、最终队列/缓存核对与最终安装仍待继续。

旧T096/SC历史部分项不改变，首次发布签收仍OPEN。正式签名、长期部署、公网点歌继续Human Gate。

## 自动验证与候选包

- 续验自动化：lint/typecheck/build通过；前端14文件43项，后端41项全回归通过，随后增加唱歌多谱排序/解绑/上传重试测试单独通过（完整后端最终计数待更新）。
- OpenAPI文档解析及path参数检查：16路径/23操作/10结构；模型与接口仅记录已实现行为，不代表公网发布。
- Java21、现有SDK、项目Gradle Wrapper，--offline构建debug与unsigned release，无新增依赖下载。
- 候选debug：14,177,294 bytes，SHA256 bb8c7a761fc93e1987fccdf112cc4d65ed38b0569af37e93ce6517d04eeb899a。
- 候选unsigned release：11,192,594 bytes，SHA256 5a342ad339b3cb2d5e0d01d01473fb342c47d082ab9ac1c9901db5dcbbcf6c0c。
- 两个候选包位于android/app/build/outputs/apk/debug/app-debug.apk、release/app-release-unsigned.apk。手机当前仍CB3wSJOp，候选wL2brn3p尚未安装，不提前声称最终安装完成。
- SQLite integrity_check=ok、foreign_key_check无错误，31真实舞蹈逐字段与本次恢复时快照一致；不改当前场景标签。

## 节目单revision续查

组件回归复现第二次在线排序baseRevision仍旧4（预期5），故此前触摸排序的持久化结论保留PARTIAL。saveProgram改用持久化最新revision，节目页订阅同步更新；回归通过。最新前端15文件45项、完整后端42项，lint/build通过。最新dist BcV7Nl9X，尚未打入手机，旧候选包hash不作最终交付。最终原五首及待同步队列必须独占真机后核对。

最后候选包已重建（BcV7Nl9X，未装机）：debug 14,177,358 bytes / SHA256 97f4d2f7007e92920a6c9fb8dec107e39a75fd393dada9649103071a09708965；unsigned release 11,192,638 bytes / SHA256 1e32db4617cdd5000230a013df00b2e463f4b88c3621a58e2621a75c3711ea8c。当前main仍ca2c3d8，所有82项工作区变更保留，未commit/push。

## 最终续验（12:32，以下覆盖上述候选与待办状态）

- 固定USB前台验收，最终资源 `index-COCJ26op.js` / `index-gQ6gbIDL.css`。唱歌卡内播放48×48 CSS px，真实触摸后 paused=false/currentTime0.138413，来源为本地 `_capacitor_file_`，手动暂停成功。大字号1.5舞蹈示例选择圈、标题、右上示例角标互不遮挡；恢复用户字号1.17、浅色、airplane0/Wi-Fi1。
- 两个节目单自身冲突均已修：连续排序使用持久化最新revision；删除节目内曲目时回传并持久化最终节目单与revision，保留后续本地删除草稿。真机连续排序9→10→11；舞蹈示例加入14→删除15→真实上移/下移16→17无冲突，之后恢复示例。新增单条/整批删除后排序回归。
- 唱歌原生批量两首：原调D、演唱调E、用途伴奏，明确字段同步；唱歌示例随后恢复C/C/REFERENCE和原创原歌词。仅示例筛选全选1，不选隐藏QA；重置筛选后已选归零。舞蹈户外+转场交集0，单户外1；未修改真实标签。
- 隔离原生QA：独立包 `com.wanghoufan.dancelibrary.qa`、独立8793库；三例5缓存→清除取消保留→确认0例0缓存→重导入3例5缓存；普通唱歌保护对照由隔离API建立，清除后仍在。首次文本表单试填未成功保存，没有计为保护证据。重复导入仍3例。
- 隔离唱歌原生SAF导入PDF+PNG，PDF两页，图片上移到首位，640px图片可读；PDF翻到2/2、canvas892×1263。解除PDF关联后只剩图片，实际原始PDF及PNG均仍存在。未修改真实吉他数据。
- 原生SAF长按多选实际显示2 selected，坏WAV与有效WAV均进入批量队列；有效音频完成，坏文件单独失败可重试。仅隔离坏文件暂存副本被故意移除，再点重试明确显示“手机副本无法读取”；确认移除后待办0。网络失败、取消竞态、权限错误保留另有自动回归；未声称全部故障分支都在真机执行。
- QA清理：真实VOCAL `711233fe-a30f-45c9-bd18-17e80d337bc3`经前台删除取消→确认→回收站恢复→再次删除→永久删除，数据库已无记录。仅本轮节目单追加移出，原五首顺序手机/服务器一致、revision17。原生“清空”取消保留五首；真正空单事务由后端回归验证，没有清空真实单。
- 数据终检：真实31 DanceItem所有字段与恢复时快照完全相同；完整性ok/外键0；原62缓存条目逐字段相同，实际手机62文件全部大小+SHA256一致；现67缓存，三类登记示例active各一。冻结吉他示例revision9/Capo3与QA revision6/Capo0不变，吉他QA留待后续方案。
- 最终前端15文件47项、后端43项全通过，lint/tsc/build通过；Java21/现有缓存离线Gradle debug+unsigned release通过；独立OpenAPI解析及路径参数检查通过。
- 最终debug：14,043,223 bytes，SHA256 `cc9eb72ea2037fcec97a1dd703dd22ce2425c62c4146115da57c0bac1b2ed259`。包名dev、Android Debug签名有效，已覆盖安装并冷启动实测上述资源。unsigned release：11,192,738 bytes，SHA256 `e2b1d2ce3ea6c4dde28da4d841bcbd01f1fe035c9f6cf82a70d89c5708c02912`，未正式签名或安装。
- 隔离QA应用已卸载、8793隔离API已关闭。仅清理本轮已知Downloads的自制WAV/PDF/PNG/二维码及两份multi副本、p040-window.xml；未清理其他Downloads，未覆盖真实库备份。
- 最终证据图片仅包含原创示例或隔离记录：`dance-demo-selection-large.png`、`vocal-inline-play-final.png`、`isolated-demo-clear.png`、`vocal-multiscore.png`；扫码图沿用`phone-qr-guest.png`。不将其他App/后台截图算通过。
- 本轮代码交付main；提交推送回执以HANDOFF与Git为准。正式签名、长期部署、公网点歌、首次发布签收和旧T096仍OPEN，吉他后续冻结。
