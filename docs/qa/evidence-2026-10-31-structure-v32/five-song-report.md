# 五首真实歌分析报告（自动统计）

song | lang | durationSec | newSections | legacySections | shortSections | avgSectionSec | minSectionSec | maxSectionSec | unknownTypes | typeCandidates | relationCandidates | boundaryNearLyricLine | codes | warnings | analyzeSeconds | peakMemoryMb | separationUsed | separationModules | tempoBpm | audioSha256
--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---
初爱 | zh | 234 | 14 | 11 | 0 | 16.7 | 10.54 | 21.74 | 13 | 4 | 2 | 8/13 | U1 U2 U3 U3 U4 U5 U6 U7 U3 U8 U4 U5 U9 尾奏 | NEEDS_TYPE_CONFIRMATION | 71.699 | 694.1 | false | none | 80.75 | 045998ed5c537bd8
Let Go | en | 206 | 12 | 22 | 2 | 17.2 | 9.38 | 26.736 | 12 | 5 | 9 | 9/11 | U1 U1 U2 U3 U4 U1 U2 U3 U4 U3 U3 U4 | NEEDS_TYPE_CONFIRMATION | 3.787 | 634 | false | none | 95.7 | a4cae4824ab76747
Papillon | en | 195 | 10 | 16 | 0 | 19.5 | 10.136 | 38.1 | 9 | 4 | 2 | 8/9 | U1 U2 U2 U3 U4 U5 U3 U4 U6 尾奏 | NEEDS_TYPE_CONFIRMATION | 2.555 | 610.2 | false | none | 172.27 | 057306bf81c0c2e1
베베 (BABE) | ko | 193 | 14 | 15 | 6 | 13.8 | 8.73 | 25.78 | 14 | 7 | 7 | 13/13 | U1 U2 U3 U4 U4 U5 U6 U4 U4 U4 U7 U7 U8 U9 | NEEDS_TYPE_CONFIRMATION | 2.485 | 616.9 | false | none | 112.35 | 28b18003c63f3991
senorita | en | 190 | 15 | 29 | 4 | 12.7 | 8.19 | 20.01 | 15 | 7 | 6 | 13/14 | U1 U2 U3 U4 U5 U6 U6 U3 U7 U5 U6 U6 U6 U8 U9 | NEEDS_TYPE_CONFIRMATION | 3.177 | 570.5 | false | none | 117.45 | 5d85d322cebfd699

- 生成的 JSON 与 LRC 均只读自用户素材目录；输出只写 var/vocal-v31-work/。
- legacySections 列为旧「重复歌词句⇒副歌」算法的段数（本轮已停止写入正式字段）。
- boundaryNearLyricLine 只是「边界是否落在歌词句首 ±1.5s」的合理性检查，**不是**边界准确率。
- 人工听辨的边界/段落纠错尚未进行，本表不能作为 AC-01 的准确率证据。
