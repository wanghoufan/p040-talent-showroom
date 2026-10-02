# 媒体真源抽样验证（media truth）

采样条数：12；媒体根：/Users/zzymima0000/Developer/coding/1.Active/040-ing-才艺展示厅/var/media

| 歌曲 | 片段码率/hash | duration(ms) | 片段 sha 一致 | source map | 原媒体 sha 一致 | stream copy |
|---|---|---|---|---|---|---|
| Big_Guy | aac/ae745c35 | 16000 | ✓ | ✓ | ✓ | 是 |
| Levitating | aac/5656af71 | 14467 | ✓ | ✓ | ✓ | 是 |
| 不再犹豫dj | aac/73e237db | 15333 | ✓ | ✓ | ✓ | 是 |
| 不要在我寂寞时说爱我 | aac/a0da373b | 15700 | ✓ | ✓ | ✓ | 是 |
| 你最近还好吗 | aac/b5c13407 | 17233 | ✓ | ✓ | ✓ | 是 |
| 你的好坏我照单全收 | aac/ff7e98da | 12900 | ✓ | ✓ | ✓ | 是 |
| 刀马刀马 | aac/ceb20c60 | 13967 | ✓ | ✓ | ✓ | 是 |
| 复仇摇 | aac/92e82959 | 14733 | ✓ | ✓ | ✓ | 是 |
| 奔跑 | aac/190ae742 | 20767 | ✓ | ✓ | ✓ | 是 |
| 妈妈的话 | aac/134fc7eb | 28700 | ✓ | ✓ | ✓ | 是 |
| 孤单北半球 | aac/c3fa2eff | 22867 | ✓ | ✓ | ✓ | 是 |
| 就是爱你 | aac/068bdc53 | 20500 | ✓ | ✓ | ✓ | 是 |

结果：12/12 通过；失败 0。

说明：片段 sha 来自 performance_clips.sha256；duration 由 ffprobe 实测与库值比对（±60ms）；source 映射核对 dance_items.source_media_id；原媒体 sha 核对来源文件未变。
