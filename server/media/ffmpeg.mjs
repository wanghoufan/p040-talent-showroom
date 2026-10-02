import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
const run = promisify(execFile);
export async function fileIdentity(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return { sha256: digest.digest('hex'), sizeBytes: statSync(path).size };
}
export async function probeMedia(path) {
  const { stdout } = await run('ffprobe', ['-v','error','-show_format','-show_streams','-of','json',path], { timeout:30000, maxBuffer:4*1024*1024 });
  const data = JSON.parse(stdout);
  const audio = data.streams?.find(s => s.codec_type === 'audio');
  const video = data.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const durationMs = Math.round(Number(data.format?.duration) * 1000);
  if (!audio || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 3600000) throw new Error('INVALID_MEDIA');
  if (!data.format?.format_name?.split(',').some(f => ['mp3','mov','mp4','m4a','wav','ogg','flac','matroska','webm','aac'].includes(f))) throw new Error('INVALID_MEDIA');
  return { durationMs, audioCodec:audio.codec_name, videoCodec:video?.codec_name, format:data.format.format_name };
}
export async function extractAudio(source, destinationBase, probe, startMs=0, endMs=probe.durationMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs<0 || endMs>probe.durationMs || endMs<=startMs) throw new Error('INVALID_CLIP');
  const copy = ['aac','mp3'].includes(probe.audioCodec);
  const codec = copy ? probe.audioCodec : 'aac';
  const path = destinationBase + (codec === 'mp3' ? '.mp3' : '.m4a');
  const args=['-v','error','-nostdin','-i',source];
  if (startMs>0) args.push('-ss',String(startMs/1000));
  if (endMs<probe.durationMs) args.push('-t',String((endMs-startMs)/1000));
  args.push('-map','0:a:0','-vn','-c:a',copy?'copy':'aac');
  if (!copy) args.push('-b:a','192k');
  if (codec==='aac') args.push('-movflags','+faststart');
  args.push('-y',path);
  await run('ffmpeg',args,{timeout:120000,maxBuffer:1024*1024});
  return { path,codec,sourcePreserving:copy,...await fileIdentity(path) };
}
export async function extractFrame(source,destination) {
  await run('ffmpeg',['-v','error','-nostdin','-i',source,'-ss','0','-frames:v','1','-vf','scale=640:-2','-y',destination],{timeout:30000,maxBuffer:1024*1024});
  return { path:destination,...await fileIdentity(destination) };
}
