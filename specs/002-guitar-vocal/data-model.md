# V2 数据模型

新增 `0003_repertoire.sql`，通过现有启动迁移自动执行。已有舞蹈记录、媒体和今晚歌单不迁移、不改写；升级前用现有 SQLite 备份工具做一致性备份。

`repertoire_items` 以 UUID 为主键，kind 固定为 GUITAR/VOCAL；歌名 1–200 字，歌手最多 200 字，original_key/performance_key 最多 40 字，capo 整数 0–12（唱歌只能为 0），score_text 最多 50000 字，notes 最多 10000 字。audio_role 为 REFERENCE/ACCOMPANIMENT。学习状态沿用 WANT_TO_LEARN/PRACTICING/CAN_DANCE 存储，界面分别显示想学/正在练/会弹或会唱。

source_media_id / performance_clip_id / cover_asset_id 可为空，允许先保存纯文本；导入现有 READY ImportJob 后事务关联原始媒体和派生音频，原始文件保留。已用于舞蹈或其他才艺的 ImportJob 不可再次绑定；同一条重复绑定幂等。删除只软删除曲目，不删除媒体；舞蹈删除媒体时额外检查未删除的才艺引用。

manifest 增加 repertoire 数组。客户端独立保存 `dance.repertoire-snapshot`，文本曲目离线可看；有音频的曲目和舞蹈合并计算下载媒体与可播放数量。缓存成功逐文件持久化，重试只补缺失/失效文件；原生文件大小与索引身份共同校验，不宣称重新计算文件哈希。缓存与服务端主数据分开。
