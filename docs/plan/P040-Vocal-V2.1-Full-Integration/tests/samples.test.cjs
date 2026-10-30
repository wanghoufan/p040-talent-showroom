const {test} = require('node:test');
const a=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {parseLrc}=require('../.check/lib/vocal/lrc.js');
const {checkVocalTrackPair}=require('../.check/lib/vocal/model.js');
const base=path.resolve(__dirname,'fixtures');
for(const id of ['harbor','city','window','pulse','orbit']) {
  test(`demo fixture ${id} has timed lyric lines`,()=>{
    const contents=fs.readFileSync(path.join(base,`${id}.lrc`),'utf8');
    const parsed=parseLrc(contents,100000);
    a.ok(parsed.lyrics.length>=3,`LRC ${id} should have >=3 timed lines`);
    a.equal(parsed.warnings.length,0,JSON.stringify(parsed.warnings));
  });
}
test('reject KTV fake tracks sharing same file, detect severe time drift',()=>{
  const media=(id,ms)=>({id,url:id,sha256:id,sizeBytes:20,version:1,durationMs:ms});
  let pair={original:{media:media('o',60000)},accompaniment:{media:media('o',60000)}};
  a.equal(checkVocalTrackPair(pair).state,'same-media');
  pair={original:{media:media('o',60000)},accompaniment:{media:media('a',70000)}};
  a.equal(checkVocalTrackPair(pair).state,'needs-alignment');
  pair={original:{media:media('o',60000)},accompaniment:{media:media('a',60050)}};
  a.equal(checkVocalTrackPair(pair).state,'ready');
  a.equal(checkVocalTrackPair({original:pair.original}).state,'one-track');
});
