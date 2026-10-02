import type { ImportStage } from '../lib/types';

const STAGES: ReadonlyArray<{ id: ImportStage; label: string }> = [
  { id: 'ACQUIRE', label: '获取视频' },
  { id: 'PROBE', label: '读取来源' },
  { id: 'EXTRACT', label: '提取音乐' },
  { id: 'RECOGNIZE', label: '识别歌曲' },
  { id: 'COVER', label: '获取封面' },
  { id: 'REVIEW', label: '生成曲目' },
];

/** 用户语言进度（T032）：只展示阶段，绝不暴露 ffmpeg/provider 命令或路径。 */
export default function ImportProgress({ stage }:{ stage:ImportStage }) {
  const index = STAGES.findIndex(s => s.id === stage);
  return <div className="import-progress" role="status" aria-live="polite">
    <div className="progress-ring" aria-hidden="true"/>
    <ol className="import-progress__steps">
      {STAGES.map((s, i) => <li key={s.id} className={i === index ? 'current-stage' : i < index ? 'done-stage' : ''}>{s.label}{i === index ? '…' : ''}</li>)}
    </ol>
  </div>;
}
