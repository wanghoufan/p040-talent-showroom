import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  acceptTypeCandidate, approveRap, approvedRapRanges, buildSongMap, changeType, clearRelation, confirmRelation,
  fromP040Sections, mapSummary, mergeAdjacent, sectionAtTime, sectionLines, sectionLoop,
  sectionSeekMs, splitAtLyric, splitAtTime, toP040Sections,
} from '../server/vocal-structure/structure-map.mjs';

/**
 * 结构地图核心（V3.2 T3）。
 * 这些用例只验证「音频证据 → 地图」的纯函数行为，不涉及真实音频，也不证明模型准确率。
 */

const SEGMENTS = [
  {start: 0, end: 15, label: 'intro', clusterId: 'c1'},
  {start: 15, end: 38, label: 'verse', clusterId: 'c2'},
  {start: 38, end: 53, label: 'pre-chorus', clusterId: 'c3'},
  {start: 53, end: 78, label: 'chorus', clusterId: 'c4'},
  {start: 78, end: 100, label: 'verse', clusterId: 'c2'},
  {start: 100, end: 126, label: 'chorus', clusterId: 'c4'},
  {start: 126, end: 148, label: 'bridge', clusterId: 'c5'},
  {start: 148, end: 168, label: 'chorus', clusterId: 'c4'},
  {start: 168, end: 180, label: 'outro', clusterId: 'c1'},
];

const LYRICS = [
  {id: 'l1', startMs: 16000, text: '城市在雨里醒来'},
  {id: 'l2', startMs: 27000, text: '灯光照着回家的路'},
  {id: 'l3', startMs: 54000, text: '把今天唱给明天听'},
  {id: 'l4', startMs: 65000, text: '把故事留给夜晚听'},
  {id: 'l5', startMs: 79000, text: '街口的店又亮起来'},
  {id: 'l6', startMs: 90000, text: '脚步慢慢找到了方向'},
  {id: 'l7', startMs: 103000, text: '把今天唱给明天听'},
  {id: 'l8', startMs: 114000, text: '把故事留给夜晚听'},
  {id: 'l9', startMs: 149000, text: '把今天唱给明天听'},
  {id: 'l10', startMs: 160000, text: '把故事留给夜晚听'},
];

const create = (override = {}) => buildSongMap({
  songId: 'example', durationMs: 180000, modelSegments: SEGMENTS, lyrics: LYRICS, ...override,
});

test('音频分段映射为 前奏 A1 P1 B1 A2 B2 C1 B3 尾奏', () => {
  const map = create();
  assert.deepEqual(map.sections.map((section) => section.code), ['前奏', 'A1', 'P1', 'B1', 'A2', 'B2', 'C1', 'B3', '尾奏']);
  assert.equal(map.status, 'draft');
  assert.equal(map.sections[3].type, 'chorus');
  assert.equal(map.sections[3].typeLabel, '副歌');
});

test('歌词不参与段类型与边界判定', () => {
  const withLyrics = create();
  const withoutLyrics = create({lyrics: []});
  const noisy = create({lyrics: [{startMs: 53000, text: '副歌副歌副歌反复反复反复'}]});
  assert.deepEqual(withoutLyrics.sections.map((s) => [s.type, s.startMs]), withLyrics.sections.map((s) => [s.type, s.startMs]));
  assert.deepEqual(noisy.sections.map((s) => [s.type, s.startMs]), withLyrics.sections.map((s) => [s.type, s.startMs]));
});

test('没有音频证据时不从歌词造段', () => {
  const map = create({modelSegments: []});
  assert.equal(map.status, 'insufficient-evidence');
  assert.deepEqual(map.sections, []);
  assert.ok(map.warnings.includes('NO_AUDIO_STRUCTURE_EVIDENCE'));
});

test('缺少 modelSegments 直接失败而不是猜', () => {
  assert.throws(() => buildSongMap({durationMs: 180000, lyrics: LYRICS}), /NO_AUDIO_STRUCTURE_EVIDENCE/);
});

test('模型越界 ≤1 秒夹取，超过 1 秒拒绝', () => {
  const clamped = create({modelSegments: [{start: 0, end: 180.4, label: 'chorus', clusterId: 'c1'}]});
  assert.equal(clamped.sections[0].endMs, 180000);
  assert.throws(() => create({modelSegments: [{start: 0, end: 190, label: 'chorus'}]}), /MODEL_SEGMENT_OUT_OF_BOUNDS/);
});

test('重叠边界直接报错，不悄悄挪动', () => {
  assert.throws(() => create({modelSegments: [
    {start: 0, end: 30, label: 'verse'}, {start: 29, end: 60, label: 'chorus'},
  ]}), /OVERLAPPING_SECTIONS/);
});

test('模型只覆盖部分音频时报告空缺，不补造段', () => {
  const map = create({modelSegments: [{start: 10, end: 20, label: 'verse'}]});
  assert.deepEqual(map.unassigned, [{startMs: 0, endMs: 10000}, {startMs: 20000, endMs: 180000}]);
  assert.equal(map.sections.length, 1);
  assert.ok(map.warnings.includes('UNCOVERED_AUDIO_RANGES'));
});

test('无法识别的标签保持待标注，同一 cluster 共用一个 U 号', () => {
  const map = create({modelSegments: [
    {start: 0, end: 10, label: 'music-unknown', clusterId: 'c9'},
    {start: 10, end: 20, label: 'segment', clusterId: 'c9'},
    {start: 20, end: 30, label: 'segment', clusterId: 'c8'},
  ], lyrics: []});
  assert.deepEqual(map.sections.map((s) => s.code), ['U1', 'U1', 'U2']);
  assert.ok(map.warnings.includes('NEEDS_TYPE_CONFIRMATION'));
});

test('前后奏只按「没人唱的区间」判定，不猜副歌', () => {
  const map = create({modelSegments: [
    {start: 0, end: 12, label: 'segment', clusterId: 'c1'},
    {start: 12, end: 170, label: 'segment', clusterId: 'c2'},
    {start: 170, end: 180, label: 'segment', clusterId: 'c3'},
  ]});
  assert.equal(map.sections[0].type, 'intro');
  assert.equal(map.sections[2].type, 'outro');
  assert.equal(map.sections[1].type, 'unknown');
});

test('声学相似只给待确认候选，不写成重复关系', () => {
  const map = create({audioEvidence: [{left: 3, right: 5, score: 0.92}, {left: 3, right: 7, score: 0.81}]});
  assert.equal(map.relationCandidates.length, 2);
  assert.equal(map.sections[5].repeatOf, undefined);
  assert.equal(map.relationCandidates[0].status, 'pending-confirmation');
  assert.ok(map.relationCandidates.every((item) => /不等于旋律相同/.test(item.note)));
});

test('低分与跨类型的相似不作为候选', () => {
  assert.deepEqual(create({audioEvidence: [{left: 3, right: 5, score: 0.35}]}).relationCandidates, []);
  assert.deepEqual(create({audioEvidence: [{left: 1, right: 3, score: 0.99}]}).relationCandidates, []);
});

test('相邻且高度相似给合并建议，不给重复建议', () => {
  const map = create({mergeCandidates: [{left: 1, right: 2, score: 0.8}]});
  assert.deepEqual(map.mergeCandidates.map((item) => [item.leftId, item.rightId]), [['analysis-2', 'analysis-3']]);
});

test('重复簇给出候选类型提示，但不写成正式类型', () => {
  const map = create({modelSegments: [
    {start: 0, end: 20, label: 'segment', clusterId: 'c1', rms: 0.12},
    {start: 20, end: 45, label: 'segment', clusterId: 'c2', rms: 0.28},
    {start: 45, end: 65, label: 'segment', clusterId: 'c1', rms: 0.13},
    {start: 65, end: 90, label: 'segment', clusterId: 'c2', rms: 0.27},
  ], lyrics: []});
  assert.equal(map.sections[1].type, 'unknown');
  assert.equal(map.sections[1].typeCandidate, 'chorus');
  assert.equal(map.sections[0].typeCandidate, 'verse');
});

test('按歌词句拆分，不需要手输秒数', () => {
  const map = splitAtLyric(create(), 'analysis-2', 'l2');
  assert.deepEqual(map.sections.slice(1, 3).map((s) => [s.code, s.startMs, s.endMs]), [['A1', 15000, 27000], ['A2', 27000, 38000]]);
  assert.equal(map.sections[2].source, 'manual');
});

test('拆分边界非法时拒绝：句不在段内 / 太靠边 / 段太短', () => {
  assert.throws(() => splitAtLyric(create(), 'analysis-2', 'l3'), /LYRIC_NOT_IN_SECTION/);
  assert.throws(() => splitAtLyric(create(), 'analysis-2', 'missing'), /LYRIC_NOT_IN_SECTION/);
  assert.throws(() => splitAtTime(create(), 'analysis-2', 15100), /SPLIT_TOO_CLOSE_TO_EDGE/);
});

test('拆开后可以合并回去，编号重新计算', () => {
  let map = splitAtLyric(create(), 'analysis-2', 'l2');
  map = mergeAdjacent(map, map.sections[1].id, map.sections[2].id);
  assert.equal(map.sections[1].endMs, 38000);
  assert.equal(map.sections[1].code, 'A1');
});

test('不能合并不相邻段；类型不同必须显式选择', () => {
  assert.throws(() => mergeAdjacent(create(), 'analysis-2', 'analysis-4'), /NOT_ADJACENT/);
  assert.throws(() => mergeAdjacent(create(), 'analysis-2', 'analysis-3'), /MIXED_TYPES_REQUIRES_CHOICE/);
  const merged = mergeAdjacent(create(), 'analysis-2', 'analysis-3', 'verse');
  assert.equal(merged.sections[1].type, 'verse');
  assert.equal(merged.sections[1].endMs, 53000);
});

test('改类型后重新编号并标记为人工；旧的 Rap 确认被清掉', () => {
  let map = changeType(create(), 'analysis-7', 'rap');
  assert.equal(map.sections[6].code, 'R1');
  assert.equal(map.sections[6].source, 'manual');
  assert.deepEqual(approvedRapRanges(map), []);
  map = approveRap(map, 'analysis-7');
  assert.deepEqual(approvedRapRanges(map), [{startMs: 126000, endMs: 148000}]);
  map = changeType(map, 'analysis-7', 'bridge');
  assert.deepEqual(approvedRapRanges(map), []);
});

test('只能确认 Rap 段为可跳过', () => {
  assert.throws(() => approveRap(create(), 'analysis-3'), /NOT_RAP/);
});

test('重复关系必须人工确认，且目标必须更早、类型一致', () => {
  const map = confirmRelation(create(), 'analysis-5', 'analysis-2', 'same-melody-new-lyrics');
  assert.equal(map.sections[4].repeatOf, 'analysis-2');
  assert.equal(map.sections[4].repetition, 'same-melody-new-lyrics');
  assert.throws(() => confirmRelation(create(), 'analysis-4', 'analysis-6', 'exact-lyrics'), /TARGET_MUST_BE_EARLIER/);
  assert.throws(() => confirmRelation(create(), 'analysis-5', 'analysis-3', 'same-melody-new-lyrics'), /TYPE_MISMATCH/);
});

test('「同词」必须歌词确实一致，否则只允许换词', () => {
  const same = confirmRelation(create(), 'analysis-6', 'analysis-4', 'exact-lyrics');
  assert.equal(same.sections[5].repetition, 'exact-lyrics');
  assert.throws(() => confirmRelation(create(), 'analysis-5', 'analysis-2', 'exact-lyrics'), /LYRICS_NOT_IDENTICAL/);
});

test('清除重复关系后回到独立段', () => {
  let map = confirmRelation(create(), 'analysis-6', 'analysis-4', 'exact-lyrics');
  map = clearRelation(map, 'analysis-6');
  assert.equal(map.sections[5].repeatOf, undefined);
  assert.equal(map.sections[5].repetition, undefined);
});

test('合并被引用段时，后续关系重绑而不是悬空', () => {
  let map = confirmRelation(create(), 'analysis-6', 'analysis-4', 'exact-lyrics');
  map = splitAtLyric(map, 'analysis-4', 'l4');
  const right = map.sections[4];
  map = confirmRelation(map, 'analysis-6', right.id, 'same-melody-new-lyrics');
  const left = map.sections[3];
  map = mergeAdjacent(map, left.id, right.id);
  assert.equal(map.sections.find((s) => s.id === 'analysis-6').repeatOf, left.id);
  assert.doesNotThrow(() => toP040Sections(map, {confirmed: true}));
});

test('改掉关系目标的类型时安全清除不兼容关系', () => {
  let map = confirmRelation(create(), 'analysis-6', 'analysis-4', 'exact-lyrics');
  map = changeType(map, 'analysis-4', 'bridge');
  assert.equal(map.sections.find((s) => s.id === 'analysis-6').repeatOf, undefined);
});

test('导出 P040 字段必须显式确认，字段与服务端一致', () => {
  assert.throws(() => toP040Sections(create()), /CONFIRMATION_REQUIRED/);
  const exported = toP040Sections(create(), {confirmed: true});
  assert.deepEqual(Object.keys(exported[0]).sort(), ['endMs', 'id', 'label', 'source', 'startMs', 'type']);
  assert.equal(exported[3].label, 'B1');
  assert.ok(exported.every((section) => section.source === 'manual'));
  assert.ok(exported.every((section) => section.label.length <= 40));
});

test('草稿导出 manual 不等于确认 Rap：未确认的 Rap 必须写成 false', () => {
  const map = changeType(create(), 'analysis-7', 'rap');
  const exported = toP040Sections(map, {confirmed: true});
  const rap = exported.find((section) => section.type === 'rap');
  assert.equal(rap.source, 'manual');
  assert.equal(rap.rapApproved, false);
  // 其他段不携带 Rap 确认字段，避免污染正式 schema。
  assert.ok(exported.filter((section) => section.type !== 'rap').every((section) => !('rapApproved' in section)));

  const approved = toP040Sections(approveRap(map, 'analysis-7'), {confirmed: true});
  assert.equal(approved.find((section) => section.type === 'rap').rapApproved, true);
});

test('载入旧正式结构：缺字段时兼容旧行为，有显式 false 时绝不确认', () => {
  const legacy = fromP040Sections([
    {id: 'r1', type: 'rap', label: 'R1', startMs: 0, endMs: 10000, source: 'manual'},
    {id: 'r2', type: 'rap', label: 'R2', startMs: 10000, endMs: 20000, source: 'manual', rapApproved: false},
    {id: 'r3', type: 'rap', label: 'R3', startMs: 20000, endMs: 30000, source: 'algorithm'},
  ], {durationMs: 30000, legacyRapFallback: true});
  assert.equal(legacy.sections[0].approvedRap, true);
  assert.equal(legacy.sections[1].approvedRap, false);
  assert.equal(legacy.sections[2].approvedRap, false);
  assert.deepEqual(approvedRapRanges(legacy), [{startMs: 0, endMs: 10000}]);

  // 应用草稿路径不得走兼容：没有显式 true 的 Rap 一律未确认。
  const strict = fromP040Sections([
    {id: 'r1', type: 'rap', label: 'R1', startMs: 0, endMs: 10000, source: 'manual'},
  ], {durationMs: 30000});
  assert.deepEqual(approvedRapRanges(strict), []);
});

test('拆分或合并 Rap 段会撤销原确认，必须重新确认', () => {
  let map = approveRap(changeType(create(), 'analysis-7', 'rap'), 'analysis-7');
  assert.equal(map.sections[6].approvedRap, true);
  const split = splitAtTime(map, 'analysis-7', 137000);
  assert.ok(split.sections.filter((section) => section.type === 'rap').every((section) => section.approvedRap === false));
  const merged = mergeAdjacent(split, split.sections[6].id, split.sections[7].id);
  assert.equal(merged.sections[6].approvedRap, false);
  assert.deepEqual(approvedRapRanges(merged), []);
});

test('显式导出时拒绝悬空关系', () => {
  const map = create();
  map.sections[5].repeatOf = 'missing';
  assert.throws(() => toP040Sections(map, {confirmed: true}), /DANGLING_RELATION/);
});

test('既有正式结构可以转成地图继续校正，不丢人工标记', () => {
  const map = fromP040Sections([
    {id: 's1', type: 'verse', label: 'A1', startMs: 0, endMs: 60000, source: 'manual'},
    {id: 's2', type: 'verse', label: 'A2', startMs: 60000, endMs: 90000, source: 'manual', repeatOf: 's1', repetition: 'same-melody-new-lyrics'},
    {id: 's3', type: 'chorus', label: 'B1', startMs: 90000, endMs: 120000, source: 'manual', repeatOf: 's1', repetition: 'unverified'},
  ], {durationMs: 120000, lyrics: [{startMs: 1000, text: '第一句'}]});
  assert.deepEqual(map.sections.map((s) => s.code), ['A1', 'A2', 'B1']);
  assert.equal(map.sections[0].source, 'manual');
  assert.equal(map.sections[1].repeatOf, 's1');
  // 类型不同的旧关系直接丢弃，不让坏数据挡住整张图。
  assert.equal(map.sections[2].repeatOf, undefined);
  assert.deepEqual(sectionLines(map, 's1').map((line) => line.text), ['第一句']);
});

test('当前段、跳转与整段循环使用同一时间轴', () => {
  const map = create();
  assert.equal(sectionSeekMs(map, 'analysis-4'), 53000);
  assert.deepEqual(sectionLoop(map, 'analysis-4'), {startMs: 53000, endMs: 78000});
  assert.equal(sectionAtTime(map, 53000).id, 'analysis-4');
  assert.equal(sectionAtTime(map, 78000).id, 'analysis-5');
  assert.equal(sectionAtTime(map, -1), null);
});

test('摘要只报告待确认数量，不冒充准确率', () => {
  const summary = mapSummary(create());
  assert.deepEqual(summary, {
    sections: 9, pendingTypes: 0, typeCandidates: 0, pendingRelations: 0,
    pendingMerges: 0, uncovered: 0, needsReview: false,
  });
});

test('候选类型必须用户采纳才生效，没有候选不猜', () => {
  const map = create({modelSegments: [
    {start: 0, end: 20, label: 'segment', clusterId: 'c1', rms: 0.12},
    {start: 20, end: 45, label: 'segment', clusterId: 'c2', rms: 0.28},
    {start: 45, end: 65, label: 'segment', clusterId: 'c1', rms: 0.13},
    {start: 65, end: 90, label: 'segment', clusterId: 'c2', rms: 0.27},
  ], lyrics: []});
  assert.equal(map.sections[1].type, 'unknown');
  const adopted = acceptTypeCandidate(map, map.sections[1].id);
  assert.equal(adopted.sections[1].type, 'chorus');
  assert.equal(adopted.sections[1].source, 'manual');
  assert.throws(() => acceptTypeCandidate(adopted, adopted.sections[1].id), /SECTION_ALREADY_TYPED/);
  // 没有 cluster 的未标注段没有候选，不能被「采纳」。
  const noCandidate = create({modelSegments: [{start: 0, end: 10, label: 'segment'}], lyrics: []});
  assert.throws(() => acceptTypeCandidate(noCandidate, 'analysis-1'), /NO_TYPE_CANDIDATE/);
});

/** 韩文歌词：同一句换空格/标点仍是同词；韩文原句与中文译句绝不能被当成同词。 */
test('韩文歌词同句可判同词，韩文与中文译文不可判同词', () => {
  const korean = [
    {id: 'k1', startMs: 1000, text: '너는 나의 봄이야'},
    {id: 'k2', startMs: 5000, text: '너는  나의 봄이야!'},
    {id: 'k3', startMs: 9000, text: '你是我的春天'},
    {id: 'k4', startMs: 13000, text: '너는 나의 봄이야'},
    {id: 'k5', startMs: 17000, text: '你是我的春天'},
  ];
  const map = buildSongMap({songId: 'ko', durationMs: 20000, lyrics: korean, modelSegments: [
    {start: 0, end: 4, label: 'chorus'}, {start: 4, end: 8, label: 'chorus'},
    {start: 8, end: 12, label: 'chorus'}, {start: 12, end: 16, label: 'chorus'},
    {start: 16, end: 20, label: 'chorus'},
  ]});
  // 第 2 段与第 1 段：空格与标点差异不影响「同词」。
  const sameKorean = confirmRelation(map, 'analysis-2', 'analysis-1', 'exact-lyrics');
  assert.equal(sameKorean.sections[1].repetition, 'exact-lyrics');
  // 第 3 段是中文译文，不能自称与韩文同词。
  assert.throws(() => confirmRelation(map, 'analysis-3', 'analysis-1', 'exact-lyrics'), /LYRICS_NOT_IDENTICAL/);
  // 但可以人工确认为「旋律同、歌词不同」。
  assert.equal(confirmRelation(map, 'analysis-3', 'analysis-1', 'same-melody-new-lyrics').sections[2].repetition, 'same-melody-new-lyrics');
});

test('编辑是纯函数：原地图不被修改', () => {
  const map = create();
  const frozen = JSON.stringify(map);
  changeType(map, 'analysis-7', 'rap');
  splitAtTime(map, 'analysis-2', 20000);
  assert.equal(JSON.stringify(map), frozen);
});

test('核心模块不读音频、不开子进程、不联网', () => {
  const source = readFileSync(new URL('../server/vocal-structure/structure-map.mjs', import.meta.url), 'utf8');
  assert.ok(!/(?:child_process|spawn\(|execFile\(|from ['"]node:fs['"]|fetch\(|WebSocket)/.test(source));
});
