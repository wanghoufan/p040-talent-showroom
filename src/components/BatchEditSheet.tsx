import { useState } from 'react';
import { STATUS_OPTIONS, SCENE_OPTIONS } from '../lib/filters';
import type { LearningStatus, SceneTag } from '../lib/types';

export interface ClassificationChange {
  learningStatus?: LearningStatus;
  sceneMode?: 'add' | 'remove' | 'replace';
  sceneTags?: SceneTag[];
}
export default function BatchEditSheet({ count, onClose, onSave }: {
  count: number; onClose: () => void; onSave: (change: ClassificationChange) => Promise<void>;
}) {
  const [status, setStatus] = useState<LearningStatus | ''>('');
  const [mode, setMode] = useState<'keep' | 'add' | 'remove' | 'replace'>('keep');
  const [tags, setTags] = useState<SceneTag[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const validTags = mode === 'replace' || ((mode === 'add' || mode === 'remove') && tags.length > 0);
  const canSave = (status !== '' || mode !== 'keep') && (mode === 'keep' || validTags);
  const save = async () => {
    setBusy(true); setError('');
    try {
      await onSave({ ...(status ? { learningStatus: status } : {}), ...(mode !== 'keep' ? { sceneMode: mode, sceneTags: tags } : {}) });
    } catch { setError('未能保存，请连接 Mac Mini 后重试。已保留所选曲目，可刷新确认后重试。'); }
    finally { setBusy(false); }
  };
  const tagLabels = tags.map(tag => SCENE_OPTIONS.find(option => option.id === tag)?.label).join('、');
  return <div className="modal-backdrop"><div className="import-sheet batch-sheet" role="dialog" aria-modal="true" aria-labelledby="batch-title">
    <header className="page-header"><h2 id="batch-title">批量修改 {count} 首</h2></header>
    <fieldset disabled={busy}>
      <label>学习状态<select value={status} onChange={event => setStatus(event.target.value as LearningStatus | '')}>
        <option value="">保持现有状态</option>{STATUS_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select></label>
      <label>标签操作<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
        <option value="keep">保持现有标签</option><option value="add">添加标签（保留原标签）</option><option value="remove">移除指定标签</option><option value="replace">替换全部标签</option>
      </select></label>
      <div className="button-row batch-tags" aria-label="要修改的场景标签">{SCENE_OPTIONS.map(option => <button key={option.id} disabled={mode === 'keep'} aria-pressed={tags.includes(option.id)} onClick={() => setTags(tags.includes(option.id) ? tags.filter(tag => tag !== option.id) : [...tags, option.id])}>{option.label}</button>)}</div>
      <p className="notice">将修改 {count} 首：{status ? `学习状态改为“${STATUS_OPTIONS.find(option => option.id === status)?.label}”` : '学习状态保持不变'}；{mode === 'keep' ? '标签保持不变' : mode === 'replace' && !tags.length ? '清空全部场景标签' : `${mode === 'add' ? '添加' : mode === 'remove' ? '移除' : '标签替换为'}${tagLabels || '（请选择标签）'}`}。</p>
    </fieldset>
    {error && <p role="alert" className="notice">{error}</p>}
    <div className="button-row"><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !canSave} onClick={() => void save()}>{busy ? '正在保存…' : '确认修改'}</button></div>
  </div></div>;
}
