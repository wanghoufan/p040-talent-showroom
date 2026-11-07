import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildSongMap,splitAtLyric,mergeAdjacent,changeType,confirmRelation,approveRap,approvedRapRanges,sectionSeekMs,sectionLoop,toP040Sections} from '../src/structure-map.mjs';
const models=JSON.parse(readFileSync(new URL('../fixtures/example-analysis.json',import.meta.url),'utf8')).segments;
const lyrics=[
 {id:'l1',startMs:16000,text:'城市在雨里醒来'}, {id:'l2',startMs:27000,text:'灯光照着回家的路'},
 {id:'l3',startMs:54000,text:'把今天唱给明天听'}, {id:'l4',startMs:65000,text:'把故事留给夜晚听'},
 {id:'l5',startMs:79000,text:'街口的店又亮起来'}, {id:'l6',startMs:90000,text:'脚步慢慢找到了方向'},
 {id:'l7',startMs:103000,text:'把今天唱给明天听'}, {id:'l8',startMs:114000,text:'把故事留给夜晚听'},
 {id:'l9',startMs:149000,text:'把今天唱给明天听'}, {id:'l10',startMs:160000,text:'把故事留给夜晚听'}
];
const create=(override={})=>buildSongMap({songId:'example',durationMs:180000,modelSegments:models,lyrics,...override});

test('normal song is mapped to intro A1 P1 B1 A2 B2 C1 B3 outro',()=>{
 const map=create();assert.deepEqual(map.sections.map(x=>x.code),['前奏','A1','P1','B1','A2','B2','C1','B3','尾奏']);assert.equal(map.status,'draft');
});
test('LRC has no influence on section class or timestamps',()=>{
 const empty=create({lyrics:[]});const changed=create({lyrics:[{startMs:53000,text:'The chorus repeated repeated repeated'}]});
 assert.deepEqual(empty.sections.map(x=>[x.type,x.startMs]),changed.sections.map(x=>[x.type,x.startMs]));
});
test('no model output means no manufactured section from LRC',()=>{assert.equal(create({modelSegments:[]}).status,'insufficient-evidence');assert.deepEqual(create({modelSegments:[]}).sections,[])});
test('missing required model evidence fails closed',()=>assert.throws(()=>buildSongMap({durationMs:180000,lyrics}),/NO_AUDIO_STRUCTURE_EVIDENCE/));
test('model clips beyond duration by ≤1s',()=>{let map=create({modelSegments:[{start:0,end:180.3,label:'chorus'}]});assert.equal(map.sections[0].endMs,180000)});
test('reject too far model timestamps',()=>assert.throws(()=>create({modelSegments:[{start:0,end:190,label:'chorus'}]}),/MODEL_SEGMENT_OUT_OF_BOUNDS/));
test('reject overlap rather than silently shifting boundary',()=>assert.throws(()=>create({modelSegments:[{start:0,end:30,label:'verse'},{start:29,end:60,label:'chorus'}]}),/OVERLAPPING_SECTIONS/));
test('model not covering full song gets a warning, not invented extra sections',()=>{const map=create({modelSegments:[{start:10,end:20,label:'verse'}]});assert.deepEqual(map.unassigned,[{startMs:0,endMs:10000},{startMs:20000,endMs:180000}])});
test('unsupported labels stay unknown',()=>{const m=create({modelSegments:[{start:0,end:10,label:'music-unknown'}]});assert.equal(m.sections[0].code,'U1')});
test('label is not melody evidence',()=>{const m=create();assert.equal(m.sections[5].repeatOf,undefined);assert.equal(m.relationCandidates.length,0)});
test('audio feature evidence alone is a suggestion, never confirmed melody repeat',()=>{
 const m=create({audioEvidence:[{left:3,right:5,score:0.92},{left:3,right:7,score:0.82}]});assert.equal(m.relationCandidates.length,2);assert.equal(m.sections[5].repeatOf,undefined);assert.equal(m.relationCandidates[0].status,'pending-confirmation');
});
test('low similarity ignored',()=>assert.deepEqual(create({audioEvidence:[{left:3,right:5,score:0.35}]}).relationCandidates,[]));
test('different type audio matches ignored',()=>assert.deepEqual(create({audioEvidence:[{left:1,right:3,score:0.99}]}).relationCandidates,[]));
test('lyric IDs are sorted independent from input order',()=>{const m=create({lyrics:[lyrics[3],lyrics[0]]});assert.deepEqual(m.sections[1].lines.map(x=>x.id),['l1'])});
test('seek exactly section beginning; loop has exact closed-open range',()=>{const m=create();assert.equal(sectionSeekMs(m,'analysis-4'),53000);assert.deepEqual(sectionLoop(m,'analysis-4'),{startMs:53000,endMs:78000})});
test('split by existing lyric line creates two editable sections without seconds entry',()=>{
 const m=splitAtLyric(create(),'analysis-2','l2');assert.deepEqual(m.sections.slice(1,3).map(x=>[x.code,x.startMs,x.endMs]),[['A1',15000,27000],['A2',27000,38000]]);assert.equal(m.sections[2].source,'manual')
});
test('refuse split on lyric outside segment',()=>assert.throws(()=>splitAtLyric(create(),'analysis-2','l3'),/LYRIC_NOT_IN_SECTION/));
test('refuse split at edge or without timestamp',()=>assert.throws(()=>splitAtLyric(create(),'analysis-2','missing'),/LYRIC_NOT_IN_SECTION/));
test('merge two adjacent sections after split to restore shape',()=>{let m=splitAtLyric(create(),'analysis-2','l2');m=mergeAdjacent(m,m.sections[1].id,m.sections[2].id);assert.equal(m.sections[1].endMs,38000);assert.equal(m.sections[1].code,'A1')});
test('merge distant sections forbidden',()=>assert.throws(()=>mergeAdjacent(create(),'analysis-2','analysis-4'),/NOT_ADJACENT/));
test('merge mismatched types needs explicit type',()=>assert.throws(()=>mergeAdjacent(create(),'analysis-2','analysis-3'),/MIXED_TYPES_REQUIRES_CHOICE/));
test('switch type recalculates stable A B C labels and marks manual',()=>{const m=changeType(create(),'analysis-7','rap');assert.equal(m.sections[6].code,'R1');assert.equal(m.sections[6].source,'manual')});
test('rap skip defaults to off even after manual type change',()=>{const m=changeType(create(),'analysis-7','rap');assert.deepEqual(approvedRapRanges(m),[])});
test('rap skip only on explicitly approved rap',()=>{const m=approveRap(changeType(create(),'analysis-7','rap'),'analysis-7');assert.deepEqual(approvedRapRanges(m),[{startMs:126000,endMs:148000}])});
test('cannot approve non-rap',()=>assert.throws(()=>approveRap(create(),'analysis-3'),/NOT_RAP/));
test('manual same melody / new words sets link and remains editable',()=>{const m=confirmRelation(create(),'analysis-5','analysis-2','same-melody-new-lyrics');assert.equal(m.sections[4].repeatOf,'analysis-2');assert.equal(m.sections[4].repetition,'same-melody-new-lyrics')});
test('manual exact lyrics link requires exact lyric content',()=>{const m=confirmRelation(create(),'analysis-6','analysis-4','exact-lyrics');assert.equal(m.sections[5].repetition,'exact-lyrics')});
test('cannot claim exact lyrics for different text',()=>assert.throws(()=>confirmRelation(create(),'analysis-5','analysis-2','exact-lyrics'),/LYRICS_NOT_IDENTICAL/));
test('cannot refer to future section',()=>assert.throws(()=>confirmRelation(create(),'analysis-4','analysis-6','exact-lyrics'),/TARGET_MUST_BE_EARLIER/));
test('save needs explicit user confirm',()=>assert.throws(()=>toP040Sections(create()),/CONFIRMATION_REQUIRED/));
test('P040 export uses existing section API shape',()=>{
 const result=toP040Sections(create(),{confirmed:true});assert.deepEqual(Object.keys(result[0]).sort(),['endMs','id','label','source','startMs','type']);assert.equal(result[3].label,'B1');
});
test('no process spawn or audio IO exists in map algorithm',()=>{
 const text=readFileSync(new URL('../src/structure-map.mjs',import.meta.url),'utf8');assert.ok(!/(?:spawn|execFile|child_process|from ['"]node:fs['"]|fetch\(|WebSocket)/.test(text));
});
test('no accidental propagation of user edits over raw song media: pure immutable edits',()=>{
 const before=create();const frozen=JSON.stringify(before);changeType(before,'analysis-7','rap');assert.equal(JSON.stringify(before),frozen);
});

test('merging a referenced section rebinds later relation instead of dangling',()=>{
 let m=create();m=confirmRelation(m,'analysis-6','analysis-4','exact-lyrics');
 // first split chorus B1 and then reference its right half explicitly
 m=splitAtLyric(m,'analysis-4','l4');
 const right=m.sections[4];
 m=confirmRelation(m,'analysis-6',right.id,'same-melody-new-lyrics');
 const left=m.sections[3];m=mergeAdjacent(m,left.id,right.id);
 const later=m.sections.find(s=>s.id==='analysis-6');assert.equal(later.repeatOf,left.id);
 assert.doesNotThrow(()=>toP040Sections(m,{confirmed:true}));
});
test('changing a relation target type clears incompatible relation safely',()=>{
 let m=confirmRelation(create(),'analysis-6','analysis-4','exact-lyrics');
 m=changeType(m,'analysis-4','bridge');
 assert.equal(m.sections.find(s=>s.id==='analysis-6').repeatOf,undefined);
});
test('explicit save rejects a dangling relation',()=>{
 const m=create();m.sections[5].repeatOf='missing';
 assert.throws(()=>toP040Sections(m,{confirmed:true}),/DANGLING_RELATION/);
});
