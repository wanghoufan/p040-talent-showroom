/** P040 V3.2 isolated prototype: pure functions, no network/audio operations.
 * Audio boundaries are EXTERNAL evidence. Lyrics never decide section types.
 */
const TYPE = {
  intro: ['intro','前奏',null], start: ['unknown','待标注','U'],
  verse: ['verse','主歌','A'], chorus: ['chorus','副歌','B'],
  'pre-chorus':['pre','预副歌','P'], prechorus:['pre','预副歌','P'], pre:['pre','预副歌','P'],
  bridge:['bridge','桥段','C'], break:['bridge','过渡','C'],
  outro:['outro','尾奏',null], end:['unknown','待标注','U'],
  rap:['rap','Rap','R'], instrumental:['unknown','器乐段','U'], solo:['unknown','独奏','U'],
  unknown:['unknown','待标注','U']
};
const FAMILY = {verse:'A',chorus:'B',pre:'P',bridge:'C',rap:'R',unknown:'U'};
const DESC = {verse:'主歌',chorus:'副歌',pre:'预副歌',bridge:'桥段',rap:'Rap',unknown:'待标注',intro:'前奏',outro:'尾奏'};
const copy=x=>structuredClone(x);
const normalizedText=s=>String(s??'').normalize('NFKC').toLowerCase().replace(/\s+/g,'').trim();
const int=n=>Number.isInteger(n);
function insist(b,why){if(!b)throw Error(why)}
function assertDuration(v){insist(int(v)&&v>0&&v<=24*3600*1000,'INVALID_DURATION')}
function validLyrics(lyrics){
  insist(Array.isArray(lyrics),'INVALID_LYRICS');
  return lyrics.filter(l=>l&&Number.isFinite(l.startMs)&&l.startMs>=0&&typeof l.text==='string')
    .map((l,i)=>({id:String(l.id??`line-${i+1}`),startMs:Math.round(l.startMs),text:l.text}))
    .sort((a,b)=>a.startMs-b.startMs);
}
function typeFromLabel(raw){
  const k=String(raw??'unknown').trim().toLowerCase().replaceAll('_','-');
  return TYPE[k]??TYPE.unknown;
}
function recode(sections){
  const counts={};
  return sections.map(s=>{
    const family=FAMILY[s.type];const code=family?`${family}${counts[family]=(counts[family]||0)+1}`:DESC[s.type];
    return {...s,code,label:code,typeLabel:DESC[s.type]};
  });
}
function checkSections(sections,durationMs){
  assertDuration(durationMs);insist(Array.isArray(sections)&&sections.length<=200,'INVALID_SECTIONS');
  const ids=new Set();let lastEnd=0;
  for(const s of sections){
    insist(typeof s.id==='string'&&s.id.length>0&&s.id.length<=64&&!ids.has(s.id),'INVALID_SECTION_ID');ids.add(s.id);
    insist(int(s.startMs)&&int(s.endMs)&&s.startMs>=0&&s.endMs<=durationMs&&s.endMs-s.startMs>=500,'INVALID_SECTION_RANGE');
    insist(s.startMs>=lastEnd,'OVERLAPPING_SECTIONS');lastEnd=s.endMs;
    insist(Object.keys(DESC).includes(s.type),'UNKNOWN_SECTION_TYPE');
  }
  for(const s of sections){
    if(s.repeatOf){
      insist(ids.has(s.repeatOf),'DANGLING_RELATION');
      const target=sections.find(x=>x.id===s.repeatOf);
      insist(target.startMs<s.startMs&&target.type===s.type,'INVALID_RELATION_TARGET');
    }
  }
}
function attachLines(sections,lyrics){return sections.map(s=>({...s,lines:lyrics.filter(l=>l.startMs>=s.startMs&&l.startMs<s.endMs)}))}
function lineContent(s){return s.lines.map(x=>normalizedText(x.text)).filter(Boolean).join('|')}
/** 
 * @param {object} o durationMs, modelSegments:[{start,end,label}] seconds (all-in-one compatible), lyrics:[{startMs,text}].
 * Optional evidence:[{left,right,score,method}] refers to indices of modelSegments, produces proposals ONLY.
 */
export function buildSongMap(o){
  assertDuration(o?.durationMs);
  const lyricLines=validLyrics(o.lyrics??[]);
  insist(Array.isArray(o.modelSegments),'NO_AUDIO_STRUCTURE_EVIDENCE');
  const filtered=[];
  for(let i=0;i<o.modelSegments.length;i++){
    const raw=o.modelSegments[i];if(!raw)continue;
    const t=typeFromLabel(raw.label);
    if(['start','end'].includes(String(raw.label??'').toLowerCase()))continue;
    insist(Number.isFinite(raw.start)&&Number.isFinite(raw.end),'INVALID_MODEL_SEGMENT');
    const startMs=Math.round(raw.start*1000),endMs=Math.round(raw.end*1000);
    if(endMs-startMs<500)continue;
    insist(startMs>=0&&endMs<=o.durationMs+1000,'MODEL_SEGMENT_OUT_OF_BOUNDS');
    filtered.push({id:`analysis-${i+1}`,originIndex:i,type:t[0],startMs,endMs:Math.min(endMs,o.durationMs),source:'algorithm',confidence:typeof raw.confidence==='number'?raw.confidence:null,approvedRap:false});
  }
  filtered.sort((a,b)=>a.startMs-b.startMs||a.endMs-b.endMs);
  // Refuse to forge a time-continuous map when the model has holes; report holes for review.
  checkSections(filtered,o.durationMs);
  const sections=attachLines(recode(filtered),lyricLines);
  const byIndex=new Map(sections.map(s=>[s.originIndex,s]));
  const relationCandidates=[];
  for(const e of o.audioEvidence??[]){
    const left=byIndex.get(e.left),right=byIndex.get(e.right);
    if(!left||!right||left.id===right.id||left.type!==right.type)continue;
    if(!Number.isFinite(e.score)||e.score<0||e.score>1)continue;
    const pair=left.startMs<right.startMs?[left,right]:[right,left];
    if(e.score<0.65)continue;
    relationCandidates.push({from:pair[1].id,to:pair[0].id,score:e.score,method:e.method||'audio-feature-similarity',status:'pending-confirmation',note:'音频特征相似不等于旋律相同；必须听辨确认',lyricMatch:!!lineContent(pair[0])&&lineContent(pair[0])===lineContent(pair[1])});
  }
  const unassigned=[];let cursor=0;
  for(const s of sections){if(s.startMs>cursor+50)unassigned.push({startMs:cursor,endMs:s.startMs});cursor=s.endMs}
  if(cursor<o.durationMs-50)unassigned.push({startMs:cursor,endMs:o.durationMs});
  return {schema:'p040.song-map.v1',songId:String(o.songId??''),durationMs:o.durationMs,analysisSource:'model-audio-boundaries',status:sections.length?'draft':'insufficient-evidence',sections,relationCandidates,warnings:[...(!sections.length?['NO_SECTIONS']:[]),...(unassigned.length?['UNCOVERED_AUDIO_RANGES']:[])],unassigned};
}
function relabelMap(map,sections){const typed=attachLines(recode(sections.map(s=>{const {lines,code,label,typeLabel,...rest}=s;return rest})),validLyrics(map.sections.flatMap(s=>s.lines)));checkSections(typed,map.durationMs);return {...map,sections:typed,status:'draft'};}
function find(map,id){const idx=map.sections.findIndex(s=>s.id===id);insist(idx>=0,'SECTION_NOT_FOUND');return idx}
/** Split by an existing LRC line time, no manually typed seconds. */
export function splitAtLyric(map,id,lineId){
  const index=find(map,id),section=map.sections[index];
  const line=section.lines.find(l=>l.id===lineId);
  insist(!!line,'LYRIC_NOT_IN_SECTION');
  insist(line.startMs-section.startMs>=500&&section.endMs-line.startMs>=500,'SPLIT_TOO_CLOSE_TO_EDGE');
  const first={...section,endMs:line.startMs,source:'manual'};
  const second={...section,id:`manual-${String(section.id).slice(0,35)}-${line.startMs}`,startMs:line.startMs,source:'manual',repeatOf:undefined,repetition:undefined};
  const next=copy(map.sections);next.splice(index,1,first,second);
  return relabelMap(map,next);
}
export function mergeAdjacent(map,leftId,rightId,chosenType){
  const a=find(map,leftId),b=find(map,rightId);insist(b===a+1,'NOT_ADJACENT');
  const left=map.sections[a],right=map.sections[b];
  insist(Math.abs(left.endMs-right.startMs)<=100,'NON_CONTIGUOUS_SECTIONS');
  insist(left.type===right.type||chosenType,'MIXED_TYPES_REQUIRES_CHOICE');
  const type=chosenType??left.type;insist(Object.keys(DESC).includes(type),'UNKNOWN_SECTION_TYPE');
  const next=copy(map.sections);next.splice(a,2,{...left,type,endMs:right.endMs,source:'manual',repeatOf:undefined,repetition:undefined});
  for(const x of next){
    if(x.id!==left.id&&(x.repeatOf===left.id||x.repeatOf===right.id)&&x.type!==type){delete x.repeatOf;delete x.repetition;x.source='manual'}
    else if(x.repeatOf===right.id){x.repeatOf=left.id;x.source='manual'}
  }
  return relabelMap(map,next);
}
export function changeType(map,id,type){
  insist(Object.keys(DESC).includes(type),'UNKNOWN_SECTION_TYPE');
  const next=copy(map.sections),i=find(map,id);next[i]={...next[i],type,source:'manual',approvedRap:false,repeatOf:undefined,repetition:undefined};
  for(const x of next)if(x.repeatOf===id&&x.type!==type){delete x.repeatOf;delete x.repetition;x.source='manual'}
  return relabelMap(map,next);
}
/** Repeat relation is never inferred solely from label or lyrics: user must explicitly confirm. */
export function confirmRelation(map,fromId,toId,relation){
  insist(['exact-lyrics','same-melody-new-lyrics'].includes(relation),'INVALID_RELATION');
  const from=find(map,fromId),to=find(map,toId);insist(to<from,'TARGET_MUST_BE_EARLIER');
  const a=map.sections[from],b=map.sections[to];insist(a.type===b.type,'TYPE_MISMATCH');
  if(relation==='exact-lyrics') insist(!!lineContent(a)&&lineContent(a)===lineContent(b),'LYRICS_NOT_IDENTICAL');
  const next=copy(map.sections);next[from]={...next[from],repeatOf:toId,repetition:relation,source:'manual'};
  return relabelMap(map,next);
}
/** Only manually confirmed Rap range may enable automatic skip in practice; not for performance. */
export function approveRap(map,id){const i=find(map,id);insist(map.sections[i].type==='rap','NOT_RAP');const next=copy(map.sections);next[i]={...next[i],approvedRap:true,source:'manual'};return relabelMap(map,next)}
export function approvedRapRanges(map){return map.sections.filter(s=>s.type==='rap'&&s.approvedRap).map(s=>({startMs:s.startMs,endMs:s.endMs}))}
export function sectionSeekMs(map,id){return map.sections[find(map,id)].startMs}
export function sectionLoop(map,id){const s=map.sections[find(map,id)];return {startMs:s.startMs,endMs:s.endMs}}
/** Only allow a deliberate manual apply. P040 backend accepts these existing fields. */
export function toP040Sections(map,{confirmed=false}={}){
  insist(confirmed,'CONFIRMATION_REQUIRED');
  checkSections(map.sections,map.durationMs);
  return map.sections.map(s=>({id:s.id,type:s.type,label:s.code,startMs:s.startMs,endMs:s.endMs,source:'manual',...(s.repeatOf?{repeatOf:s.repeatOf}:{}),...(s.repetition?{repetition:s.repetition}:{})}));
}
