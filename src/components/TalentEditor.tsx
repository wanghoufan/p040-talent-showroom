import { useState } from 'react';
import type { TalentItem, TalentKind } from '../lib/types';
import { talentStatuses } from '../lib/repertoire-store';
export type TalentFields = Pick<TalentItem, 'title' | 'artist' | 'learningStatus' | 'originalKey' | 'performanceKey' | 'capo' | 'scoreText' | 'notes' | 'audioRole'>;
export default function TalentEditor({ kind, item, onSave, onCancel }: { kind: TalentKind; item?: TalentItem; onSave: (value: TalentFields) => Promise<void>; onCancel: () => void }) {
 const [value, setValue] = useState<TalentFields>({ title: item?.title || '', artist: item?.artist || '', learningStatus: item?.learningStatus || 'WANT_TO_LEARN', originalKey: item?.originalKey || '', performanceKey: item?.performanceKey || '', capo: item?.capo || 0, scoreText: item?.scoreText || '', notes: item?.notes || '', audioRole: item?.audioRole || (kind === 'VOCAL' ? 'ACCOMPANIMENT' : 'REFERENCE') });
 const [busy, setBusy] = useState(false), [error, setError] = useState('');
 const change = <K extends keyof TalentFields>(key: K, next: TalentFields[K]) => setValue(v => ({ ...v, [key]: next }));
 return <form className="review-form talent-editor" onSubmit={e => { e.preventDefault(); setBusy(true); setError(''); void onSave(value).catch(() => setError('未能保存，请检查 Mac Mini 连接；填写的内容保留。')).finally(() => setBusy(false)); }}><fieldset disabled={busy}>
 <label>歌名<input required maxLength={200} value={value.title} onChange={e => change('title', e.target.value)} /></label><label>歌手<input maxLength={200} value={value.artist} onChange={e => change('artist', e.target.value)} /></label>
 <label>学习状态<select value={value.learningStatus} onChange={e => change('learningStatus', e.target.value as TalentItem['learningStatus'])}>{talentStatuses(kind).map(s => <option value={s.id} key={s.id}>{s.label}</option>)}</select></label>
 <div className="talent-key-row"><label>原调<input maxLength={40} placeholder="例如 C" value={value.originalKey} onChange={e => change('originalKey', e.target.value)} /></label><label>{kind === 'GUITAR' ? '演奏调' : '演唱调'}<input maxLength={40} placeholder="例如 D" value={value.performanceKey} onChange={e => change('performanceKey', e.target.value)} /></label></div>
 {kind === 'GUITAR' && <label>Capo（变调夹品位）<input type="number" min={0} max={12} required value={value.capo} onChange={e => change('capo', Number(e.target.value))} /></label>}
 <label>{kind === 'GUITAR' ? '和弦 / 歌词文本谱' : '歌词'}<textarea rows={10} maxLength={50000} value={value.scoreText} onChange={e => change('scoreText', e.target.value)} placeholder={kind === 'GUITAR' ? '[C]歌词第一行\n[G]歌词第二行' : '粘贴你自己的歌词，保留分行'} /></label>
 <label>音频用途<select value={value.audioRole} onChange={e => change('audioRole', e.target.value as TalentItem['audioRole'])}><option value="REFERENCE">原唱 / 示范</option><option value="ACCOMPANIMENT">伴奏</option></select></label>
 <label>练习备注<textarea rows={3} maxLength={10000} value={value.notes} onChange={e => change('notes', e.target.value)} /></label>
 <p className="muted">调性与 Capo 用于记录，不会自动改变音频。可先保存文本，再导入音乐。</p>
 </fieldset>{error && <p role="alert">{error}</p>}<div className="button-row"><button type="button" disabled={busy} onClick={onCancel}>取消</button><button className="primary" disabled={busy || !value.title.trim()}>{busy ? '正在保存…' : '保存曲目'}</button></div></form>;
}
