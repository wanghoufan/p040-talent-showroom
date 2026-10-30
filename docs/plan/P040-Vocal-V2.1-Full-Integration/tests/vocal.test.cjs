const { test } = require('node:test');
const a = require('node:assert/strict');
const { parseLrc, lyricIndexAt } = require('../.check/lib/vocal/lrc.js');
const { validateSections, rapRanges, skipRapTarget, lyricRepeatRange, clampSeek, nextPlaybackAction } = require('../.check/lib/vocal/timeline.js');
const { resolveVocalTracks, preferredVocalRole, playableVocalTrack, uniqueVocalMedia } = require('../.check/lib/vocal/model.js');
const { switchVocalTrack } = require('../.check/lib/vocal/tracks.js');
const { guessLocalFileRole, normalizedSongKey, canonicalImportNames } = require('../.check/lib/vocal/import-contract.js');
const sample = (n,url)=>({id:n,url,sha256:'sha',sizeBytes:1234,version:1});
const sec = (id,type,startMs,endMs,extra={})=>({id,type,startMs,endMs,label:id,source:'manual',...extra});
const sections = [sec('r1','rap',4000,22000),sec('v','verse',22000,34000),sec('r2','rap',34000,54000)];

test('parse basic LRC: BOM, Chinese/English/Korean, line end from next timestamp',()=>{
  const r = parseLrc('\ufeff[ar:tester]\r\n[00:01.50]海风来信\r\n[00:03.250]Open Windows\r\n[00:06.00]별빛 궤도',8000);
  a.equal(r.lyrics.length,3); a.deepEqual(r.lyrics.map(x=>x.startMs),[1500,3250,6000]);
  a.deepEqual(r.lyrics.map(x=>x.endMs),[3250,6000,8000]);
  a.equal(r.lyrics[2].text,'별빛 궤도'); a.equal(r.metadata.ar,'tester');
});
test('parse timestamps, multiple tags, duplicate timestamp, out of range',()=>{
  const r=parseLrc('[00:01.00][00:02.00]repeat\n[00:02.00]repeat\n[00:02.00]ambiguous\n[00:75.00]bad\n[02:00.00]beyond',10000);
  a.deepEqual(r.lyrics.map(x=>x.startMs),[1000,2000]);
  a.ok(r.warnings.some(x=>x.includes('相同时间戳')));
  a.ok(r.warnings.some(x=>x.includes('超出范围')));
});
test('parse LRC offset and nearest lyric at time',()=>{
  const r=parseLrc('[offset:100]\n[00:01.10]one\n[00:02.00]two',5000);
  a.deepEqual(r.lyrics.map(x=>x.startMs),[1200,2100]);
  a.equal(lyricIndexAt(r.lyrics,0),-1); a.equal(lyricIndexAt(r.lyrics,2099),0);
  a.equal(lyricIndexAt(r.lyrics,2100),1);
});
test('no LRC timestamps disallows line looping rather than faking accuracy',()=>{
  const r=parseLrc('Hello\nThere'); a.equal(r.lyrics.length,0);
  a.ok(r.warnings[0].includes('校准'));
});
test('Rap skip is half-open and merges neighboring and overlapping ranges',()=>{
  const parts=[sec('a','rap',4000,10000),sec('b','rap',10000,20000),sec('c','rap',19000,21000),sec('d','rap',40000,48000)];
  a.deepEqual(rapRanges(parts,60000),[{startMs:4000,endMs:21000},{startMs:40000,endMs:48000}]);
  a.equal(skipRapTarget(20000,parts,60000),21000);
  a.equal(skipRapTarget(21000,parts,60000),null);
  a.equal(skipRapTarget(39999,parts,60000),null);
  a.equal(skipRapTarget(40000,parts,60000),48000);
});
test('two Rap ranges in a heavily rapped track are both skipped',()=>{
  a.deepEqual(nextPlaybackAction({positionMs:4000,durationMs:72000,sections,mode:'normal',skipRap:true}),{kind:'seek',positionMs:22000});
  a.deepEqual(nextPlaybackAction({positionMs:35000,durationMs:72000,sections,mode:'rehearsal-once',skipRap:false}),{kind:'seek',positionMs:54000});
  a.deepEqual(nextPlaybackAction({positionMs:22000,durationMs:72000,sections,mode:'normal',skipRap:true}),{kind:'none'});
  a.deepEqual(nextPlaybackAction({positionMs:72000,durationMs:72000,sections,mode:'rehearsal-once',skipRap:true}),{kind:'stop'});
});
test('repeat last 4 lines incl selected line 8 => lines 5..8',()=>{
  const l=Array.from({length:10},(_,i)=>({id:''+i,startMs:(i+1)*1000,endMs:(i+2)*1000,text:''+i}));
  a.deepEqual(lyricRepeatRange(l,7,4,15000),{startMs:5000,endMs:9000});
  a.equal(lyricRepeatRange(l,10,4,15000),null);
  a.equal(lyricRepeatRange(l,7,0,15000),null);
});
test('explicit rap lyric loop overrides global Rap skipping',()=>{
  const p=nextPlaybackAction({positionMs:5000,durationMs:72000,mode:'line-repeat',skipRap:true,sections,lineRange:{startMs:4000,endMs:9000}});
  a.deepEqual(p,{kind:'none'});
});
test('validate malformed section, dangling reference; constrain seek',()=>{
  const invalid=[sec('same','rap',8,6),sec('same','verse',2,3,{repeatOf:'missing'})];
  a.ok(validateSections(invalid,10).length>=3);
  a.equal(clampSeek(1000,-5,10000),0);a.equal(clampSeek(9000,10,10000),10000);
});
test('legacy audioRole maps exactly one track; no invented opposite audio',()=>{
  const original=sample('1','x.mp3');const accomp=sample('2','y.mp3');
  let tracks=resolveVocalTracks({kind:'VOCAL',audio:original,audioRole:'REFERENCE'});
  a.equal(tracks.original.media.url,'x.mp3');a.equal(tracks.accompaniment,undefined);
  a.equal(preferredVocalRole(tracks,'performance'),null);
  a.equal(preferredVocalRole(tracks,'practice'),'original');
  tracks=resolveVocalTracks({kind:'VOCAL',audio:original,audioRole:'REFERENCE',vocalTracks:{accompaniment:{media:accomp}}});
  a.equal(preferredVocalRole(tracks,'performance'),'accompaniment');
  a.equal(playableVocalTrack(tracks,'original').media.url,'x.mp3');
  a.equal(resolveVocalTracks({kind:'GUITAR',audio:original}).original,undefined);
  a.deepEqual(uniqueVocalMedia(tracks).map(x=>x.url),['y.mp3','x.mp3']);
});
test('same physical file not downloaded twice',()=>{
  const m=sample('same','media1');a.equal(uniqueVocalMedia({original:{media:m},accompaniment:{media:m}}).length,1);
});
test('file role is inferred conservatively and normalized',()=>{
  a.deepEqual(guessLocalFileRole('海风来信 - 伴奏.mp3'),{baseName:'海风来信',role:'accompaniment'});
  a.deepEqual(guessLocalFileRole('Blue Bird (original).mp3'),{baseName:'Blue Bird',role:'original'});
  a.equal(guessLocalFileRole('Blue Bird.mp3').role,'unknown');
  a.equal(normalizedSongKey('  Blue＿Bird - 伴奏.MP3'), 'blue bird');
  a.equal(canonicalImportNames('harbor').accompaniment,'harbor.accompaniment.mp3');
  a.throws(()=>canonicalImportNames('..'));
});

class FakeAudio {
  constructor({bad=[]}={}){this.src='old.mp3';this.currentTime=28;this.paused=false;this.volume=.7;this.muted=true;this.playbackRate=1.25;this.listeners=new Map();this.bad=bad;}
  pause(){this.paused=true;}
  async play(){this.paused=false;}
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
  removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
  emit(name){for(const f of this.listeners.get(name)||[])f();}
  load(){queueMicrotask(()=>this.emit(this.bad.includes(this.src)?'error':'loadedmetadata'));}
}
const doubleTracks={original:{media:sample('o','old.mp3'),offsetMs:200},accompaniment:{media:sample('a','new.mp3'),offsetMs:700}};
test('switch from original to accompaniment keeps current position, state and rate',async()=>{
  const audio=new FakeAudio();
  await switchVocalTrack(audio,{tracks:doubleTracks,fromRole:'original',toRole:'accompaniment',resolveUrl:async()=> 'new.mp3'});
  a.equal(audio.src,'new.mp3');a.equal(audio.currentTime,28.5);a.equal(audio.paused,false);
  a.equal(audio.volume,.7);a.equal(audio.muted,true);a.equal(audio.playbackRate,1.25);
});
test('switch when paused remains paused',async()=>{
  const audio=new FakeAudio();audio.paused=true;
  await switchVocalTrack(audio,{tracks:doubleTracks,fromRole:'original',toRole:'accompaniment',resolveUrl:async()=> 'new.mp3'});
  a.equal(audio.paused,true);
});
test('no accompaniment throws before touching original playback',async()=>{
  const audio=new FakeAudio();
  await a.rejects(switchVocalTrack(audio,{tracks:{original:doubleTracks.original},fromRole:'original',toRole:'accompaniment',resolveUrl:async()=> 'new.mp3'}));
  a.equal(audio.src,'old.mp3');a.equal(audio.paused,false);
});
test('unavailable cache URL does not touch original playback',async()=>{
  const audio=new FakeAudio();
  await a.rejects(switchVocalTrack(audio,{tracks:doubleTracks,fromRole:'original',toRole:'accompaniment',resolveUrl:async()=> {throw Error('missing cache');}}));
  a.equal(audio.paused,false);
});
test('failed target audio rolls back previous source and playback',async()=>{
  const audio=new FakeAudio({bad:['bad.mp3']});
  await a.rejects(switchVocalTrack(audio,{tracks:doubleTracks,fromRole:'original',toRole:'accompaniment',resolveUrl:async()=> 'bad.mp3'}));
  a.equal(audio.src,'old.mp3');a.equal(audio.currentTime,28);a.equal(audio.paused,false);
});
test('global LRC offset applies even when metadata is after lines',()=>{
  const r=parseLrc('[00:01.00]test\n[offset:250]',3000);
  a.equal(r.lyrics[0].startMs,1250);
});
test('Rap at song tail stops one-time rehearsal but wraps normal loop',()=>{
  const tail=[sec('tail','rap',9000,10000)];
  const base={positionMs:9500,durationMs:10000,sections:tail,skipRap:true};
  a.deepEqual(nextPlaybackAction({...base,mode:'rehearsal-once',wholeTrackLoop:true}),{kind:'stop'});
  a.deepEqual(nextPlaybackAction({...base,mode:'normal',wholeTrackLoop:true}),{kind:'seek',positionMs:0});
  a.deepEqual(nextPlaybackAction({...base,mode:'normal',wholeTrackLoop:false}),{kind:'stop'});
});
test('manual file pairing identifies song, separates original/accompaniment/LRC',()=>{
  const {groupVocalFiles}=require('../.check/lib/vocal/import-contract.js');
  const r=groupVocalFiles(['海风来信.mp3','海风来信 - 伴奏.mp3','海风来信.lrc','Neon Pulse - Original.mp3','Neon Pulse - Karaoke.mp3']);
  a.equal(r.length,2);
  const c=r.find(x=>x.songKey==='海风来信');
  a.equal(c.original,'海风来信.mp3');
  a.equal(c.accompaniment,'海风来信 - 伴奏.mp3');
  a.equal(c.lyrics,'海风来信.lrc');
  a.ok(c.needsReview.some(x=>x.includes('未标注')));
});
