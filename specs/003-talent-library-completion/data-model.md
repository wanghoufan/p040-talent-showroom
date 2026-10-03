# 完整化数据模型与持久化约束

基线：0001–0003 保持原有舞蹈/才艺主表，不改已执行迁移。0004–0006 增量升级，迁移前 SQLite 一致性备份；真实媒体、数据库和设备凭据不入 Git。

2026-10-03 用户冻结吉他后续开发及数据修改；下述已实现公共结构保留，吉他后续产品验收暂缓。

## 服务端

- `ItemRef = {kind:DANCE|GUITAR|VOCAL,id:UUID}`。主表独立：DANCE→dance_items；其他→repertoire_items。普通列表排除 deleted_at，回收站查询包含三类。
- `revision` 从 1 起，更新触发器递增。同步操作携带 baseRevision；失配返回服务器版本，业务数据不覆盖。客户端 UUID 创建支持重试；operationId 不可复用于不同载荷。
- `operation_results(id,fingerprint,result_json,created_at)`：业务修改与幂等结果同事务；指纹核对防止操作 ID 被复用。bulk 全部校验后单事务，任一失败回滚。
- `demo_records(kind,item_id,slot,media_json)`：独立示例身份，普通编辑不改变登记；slot 唯一，重复导入不覆盖用户编辑。清除仅删除登记记录/节目引用，素材无跨记录引用才清理。回收站引用同样保护素材。
- `program_meta(singleton=1,revision)` 与 `program_items(kind,item_id,position)`：只维护一份混合节目单，ItemRef 唯一且 position 唯一。旧 tonight_playlist_items 按原顺序迁移；删除曲目移出节目单，恢复不恢复原位置。文本曲目合法且不需要音频。
- `score_assets(id,kind,mime,internal_path,sha256,size_bytes,pages)` 与 `score_links(kind,item_id,asset_id,position)`：一项多谱且稳定排序。客户端只能使用 opaque ID/受控媒体地址。PNG/JPG/WebP 最大10MiB，PDF 最大25MiB/100页，实际解码校验；排序/解绑保留原件。
- `owner_credentials(token_hash,created_at)`：只存主人 token 哈希。配对码在本机0600文件，配对后所有私有API需Bearer；媒体兼容owner查询参数，不写入访客响应或二维码。
- `request_sessions(id,token,expires_at,closed,subset_json)`：32字符随机 token，24h会话，默认公开子集空。访客响应仅 kind/id/title。
- `guest_requests(id,session_id,visitor,kind,item_id,nickname,note,state,created_at)`：state=PENDING/ACCEPTED/REJECTED。同访客同曲目未处理请求去重；每分钟5个新请求，每场最多200待处理。接受事务加入节目单，不触发播放；清理历史只删除已处理项。

## Android 本地

IndexedDB `dance-library` v1：metadata（键值JSON）、operations（operationId主键）、files（id主键）。旧 localStorage 快照校验迁入前保留，不删除旧副本。metadata与操作队列同事务落盘后更新内存；容量失败不得虚报保存成功。

- 元数据键：dance.catalog-snapshot / dance.repertoire-snapshot / dance.offline.manifest / dance.program / dance.trash / dance.file-results。
- operations：kind/id/action/baseRevision/fields/operationId/createdAt，state=pending/conflict/failed。依赖操作顺序提交；网络故障留队。采用Mac版本仅撤销冲突操作，后续手机草稿重放；首个后续操作改用服务器revision。
- files：id/name/mime/kind/itemId/path或blob/state/jobId/uploadId/createFields。原生副本使用256KiB分块保存在dance-pending；成功处理后删待办副本，失败保留并明确原因；移除等待正在处理任务结束。丢失副本可清待办，权限错误保留。
- 离线缓存索引：`dance.offline.cache`；元数据与音频/封面/谱实体分离。就绪检查包含所需谱、实际文件存在/大小与索引版本；不把索引命中等同于完整SHA重新校验。演出缺音频/谱不回退网络。
- PDF.js worker/CMap/字体/WASM随APK打包，不用CDN；按当前页渲染，书签以dance.score-page.<id>保存。歌词默认手动，可调速自动滚动，触摸暂停。

## 保护与冻结

真实舞蹈和已有缓存升级保留；恢复时当前数据库为保护真源，不用旧备份覆盖当前修改。吉他既有实现和数据冻结，后续验收、QA吉他记录清理待用户新方案。正式签名、长期部署、公网点歌和首次签收仍由Human Gate决定。

删除节目内曲目同步结果同时返回最终program和programRevision。手机持久化此版本并保留后续本地移除草稿，避免删除成功后继续排序造成自身冲突。
