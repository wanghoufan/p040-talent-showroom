import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { probeMedia, extractAudio } from '../server/media/ffmpeg.mjs';
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
test('actual FFmpeg extraction preserves source and AAC packets without shell interpolation', async () => {
  const dir = mkdtempSync(join(tmpdir(),'dance-media-'));
  try {
    const source=join(dir,'舞蹈 $().mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x120:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac','-shortest',source]);
    const before=hash(source);
    const probe=await probeMedia(source);
    assert.ok(probe.durationMs >= 990 && probe.durationMs <= 1100);
    assert.equal(probe.audioCodec,'aac');
    const result=await extractAudio(source,join(dir,'clip'),probe);
    assert.equal(result.sourcePreserving,true);
    assert.equal(result.codec,'aac');
    assert.equal(hash(source),before);
    const packets = file => execFileSync('ffmpeg',['-v','error','-i',file,'-map','0:a:0','-c','copy','-f','hash','-hash','sha256','-']).toString().trim();
    assert.equal(packets(source),packets(result.path));
    const fake=join(dir,'fake.mp4'); writeFileSync(fake,'not a video');
    await assert.rejects(probeMedia(fake));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
