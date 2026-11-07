#!/usr/bin/env node
/** Deterministic converter from existing audio-structure JSON + existing LRC; does NOT read or process audio. */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {buildSongMap} from './structure-map.mjs';
function usage(){throw Error('Usage: node src/cli.mjs --analysis <allinone.json> --lrc <song.lrc> --duration-ms <ms> --out <map.json> [--song-id <id>]')}
const opts={};for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i];if(!k?.startsWith('--')||!process.argv[i+1])usage();opts[k.slice(2)]=process.argv[i+1]}
for(const key of ['analysis','lrc','duration-ms','out'])if(!opts[key])usage();
const analysis=JSON.parse(readFileSync(resolve(opts.analysis),'utf8'));
const lrcText=readFileSync(resolve(opts.lrc),'utf8').replace(/^\ufeff/,'');
let lineId=0;let offset=0;let lines=[];
for(const line of lrcText.split(/\r?\n/)){
  const off=line.match(/^\[offset:([+-]?\d+)\]/i);if(off){offset=Number(off[1]);continue}
  const tags=[...line.matchAll(/\[(\d{1,4}):(\d\d)(?:[.](\d{1,3}))?\]/g)];
  if(!tags.length)continue;
  const text=line.replace(/\[(\d{1,4}):(\d\d)(?:[.](\d{1,3}))?\]/g,'').trim();if(!text)continue;
  for(const m of tags){const frac=(m[3]||'').padEnd(3,'0');lines.push({id:`line-${++lineId}`,startMs:Number(m[1])*60000+Number(m[2])*1000+Number(frac)+offset,text})}
}
lines=lines.filter(l=>l.startMs>=0);
const modelSegments=analysis.segments??analysis.result?.segments;if(!modelSegments)throw Error('NO_SEGMENTS_IN_MODEL_JSON');
const result=buildSongMap({songId:opts['song-id']||'',durationMs:Number(opts['duration-ms']),modelSegments,lyrics:lines});
writeFileSync(resolve(opts.out),JSON.stringify(result,null,2)+'\n');
console.log(`Created ${opts.out}: ${result.sections.length} sections, ${result.warnings.length} warning(s); not applied to P040.`);
