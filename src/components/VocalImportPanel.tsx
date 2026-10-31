import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { queueFile, readLocalText } from '../lib/offline-files';
import { editLocally } from '../lib/offline-editing';
import { parseLrc, resolveLineTimings, resolveTracks, trackPairStatus } from '../lib/vocal';
import type { TalentItem } from '../lib/types';
import VocalSectionEditor from './VocalSectionEditor';
import VocalStructureDraftPanel from './VocalStructureDraftPanel';
import '../styles/vocal-practice.css';

/**
 * 同一首曲目的手动补录入口（V2.1 过渡形态）。
 *
 * 原唱、伴奏、LRC 全部写回当前 songId：音频进离线导入队列并按 track 落到对应角色，
 * 歌词/结构走离线编辑队列；任何时候都不会因为选了三个文件而新建三首曲目。
 * 本面板只负责手动补录（备用通道）；本地智能导入已在「我的 → 本地智能导入」接入，
 * 那里在 Mac mini 上扫描已登记目录并用本机模型提取伴奏，手机不运行提取模型。
 */

const ROLE_LABEL = { original: '原唱', accompaniment: '伴奏' } as const;
type Role = keyof typeof ROLE_LABEL;

interface Props {
  item: TalentItem;
  /** 结构草稿应用后回写前端缓存，详情页不必整页刷新。 */
  onUpdated?: (item: TalentItem) => void;
}

const rowStyle = { display: 'grid', gap: '6px', marginTop: '8px' } as const;
const inputStyle = { minHeight: '44px', padding: '0 10px', fontSize: '19px' } as const;

export default function VocalImportPanel({ item, onUpdated }: Props) {
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingSections, setEditingSections] = useState(false);
  const [confirmRole, setConfirmRole] = useState<Role | null>(null);
  const trackInput = useRef<HTMLInputElement>(null);
  const lyricInput = useRef<HTMLInputElement>(null);
  const pendingRole = useRef<Role>('original');
  const replacing = useRef(false);

  const tracks = resolveTracks(item);
  const pair = trackPairStatus(tracks);
  const sectionCount = item.sections?.length || 0;
  const lyricCount = item.lyrics?.length || 0;

  // 已有同角色音轨时先停下来二次确认：替换是显式动作，不能因为点错就静默顶掉原音轨。
  const pickTrack = (role: Role) => {
    if (tracks[role]) { setConfirmRole(role); return; }
    pendingRole.current = role; replacing.current = false; trackInput.current?.click();
  };
  const confirmReplace = () => {
    if (!confirmRole) return;
    pendingRole.current = confirmRole; replacing.current = true; setConfirmRole(null); trackInput.current?.click();
  };

  async function importTrack(role: Role, file: File) {
    const replace = replacing.current;
    replacing.current = false;
    setBusy(true); setError(''); setNotice('');
    try {
      await queueFile(file, { kind: 'VOCAL', id: item.id }, 'MEDIA', { title: item.title, track: role, ...(replace ? { replace: true } : {}) });
      setNotice(replace
        ? `「${ROLE_LABEL[role]}」替换已保存到手机，联网后生效；旧文件保留在服务器上，不会被删除。`
        : `「${ROLE_LABEL[role]}」已保存到手机，联网后自动关联到这首曲目（不会新建曲目）。`);
    } catch (cause) {
      const detail = cause instanceof Error && cause.message ? cause.message : '文件尚未保存';
      setError(`「${ROLE_LABEL[role]}」导入未完成：${detail}；已保存的曲目资料不受影响。`);
    } finally { setBusy(false); }
  }

  async function importLyric(file: File) {
    setBusy(true); setError(''); setNotice('');
    try {
      const text = await readLocalText(file);
      const doc = parseLrc(text);
      if (!doc.hasUsableTiming) {
        setError(doc.issues.includes('INVALID_TIMESTAMP')
          ? '这份 LRC 的时间戳格式不正确（应为 [mm:ss.xx]），未保存。'
          : '这份 LRC 没有可用的 [mm:ss] 时间戳，未保存：未校时的歌词不会自动生成假时间。');
        return;
      }
      await editLocally({ kind: 'VOCAL', id: item.id }, { lyrics: resolveLineTimings(doc.lines) }, 'update');
      setNotice(`已保存 ${doc.lines.length} 句同步歌词${doc.untimedLines.length ? `，另有 ${doc.untimedLines.length} 行没有时间戳未计入` : ''}。`);
    } catch (cause) {
      const detail = cause instanceof Error && cause.message ? cause.message : '保存失败';
      setError(`歌词未保存：${detail}。可先保存曲目文本，联网后再补 LRC。`);
    } finally { setBusy(false); }
  }

  return (
    <section className="vocal-block" aria-labelledby="vocal-import-title">
      <h2 id="vocal-import-title">补录音轨与歌词</h2>
      <p className="vocal-hint">原唱、伴奏、歌词都归到这一首曲目（{item.title}），同一首歌不会变成三首。</p>

      <div style={rowStyle}>
        <button type="button" id="vocal-import-original" disabled={busy} onClick={() => pickTrack('original')} style={inputStyle}>
          {tracks.original ? '替换原唱音频' : '导入原唱音频'}
        </button>
        <button type="button" disabled={busy} onClick={() => pickTrack('accompaniment')} style={inputStyle}>
          {tracks.accompaniment ? '替换伴奏音频' : '导入伴奏音频'}
        </button>
        <button type="button" disabled={busy} onClick={() => lyricInput.current?.click()} style={inputStyle}>
          {lyricCount ? '替换 LRC 歌词' : '导入 LRC 歌词'}
        </button>
        <button type="button" disabled={busy} onClick={() => setEditingSections(true)} style={inputStyle}>
          {sectionCount ? '校准歌曲结构' : '手工标注歌曲结构'}
        </button>
      </div>

      {confirmRole && (
        <div role="alertdialog" aria-label="确认替换音轨">
          <p className="vocal-hint" role="alert">将用新文件替换「{ROLE_LABEL[confirmRole]}」。旧文件会保留在服务器上，但曲目将改用新文件。</p>
          <div style={rowStyle}>
            <button type="button" disabled={busy} onClick={confirmReplace} style={inputStyle}>确认替换{ROLE_LABEL[confirmRole]}</button>
            <button type="button" disabled={busy} onClick={() => setConfirmRole(null)} style={inputStyle}>取消替换</button>
          </div>
        </div>
      )}

      <p className="vocal-hint" role="status">
        原唱：{tracks.original ? '已导入' : '未提供'} · 伴奏：{tracks.accompaniment ? '已导入' : '未提供'}
        {' · '}歌词：{lyricCount ? `${lyricCount} 句（已校时）` : '未导入'} · 结构：{sectionCount ? `${sectionCount} 段` : '未标注'}
      </p>
      {pair.state === 'same-media' && <p className="vocal-hint" role="alert">原唱和伴奏引用了同一个文件，不能当作双音轨，请导入真正独立的伴奏。</p>}
      {pair.state === 'needs-alignment' && <p className="vocal-hint" role="alert">{pair.detail}。可用「校准歌曲结构」或替换其中一条音轨。</p>}

      <div style={rowStyle}>
        <Link
          to="/settings"
          aria-describedby="vocal-ai-hint"
          style={{ ...inputStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', color: 'inherit', border: '1px solid var(--line)', borderRadius: '9px', background: 'var(--surface)' }}
        >
          前往「我的」使用本地智能导入
        </Link>
      </div>
      <p className="vocal-hint" id="vocal-ai-hint">
        本地智能导入已在「我的 → 本地智能导入」可用：在 Mac mini 上扫描已登记的音乐文件夹，用本机模型提取伴奏（人声分离，不是生成新伴奏），音频不上传云端；需先连接并配对 Mac mini，手机不运行提取模型。上面的手动导入仍可随时补录或替换音轨。
      </p>

      <h3 style={{ margin: '18px 0 4px', fontSize: '19px' }}>原唱结构分析</h3>
      <p className="vocal-hint">直接读原唱混音猜段落边界与相似段，不做人声/伴奏分离；结果是草稿，确认后才替换正式结构。</p>
      <VocalStructureDraftPanel item={item} hasOriginalTrack={Boolean(tracks.original)} onUpdated={onUpdated} />

      {notice && <p className="vocal-hint" role="status">{notice}</p>}
      {error && <p className="vocal-hint" role="alert">{error}</p>}

      <input
        ref={trackInput}
        type="file"
        accept="audio/*"
        hidden
        aria-label="选择音轨文件"
        onChange={(event) => {
          const file = event.target.files?.[0];
          const role = pendingRole.current;
          event.target.value = '';
          if (file) void importTrack(role, file);
        }}
      />
      <input
        ref={lyricInput}
        type="file"
        accept=".lrc,text/plain"
        hidden
        aria-label="选择 LRC 歌词文件"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importLyric(file);
        }}
      />

      {editingSections && (
        <VocalSectionEditor
          item={item}
          onClose={() => setEditingSections(false)}
          onSaved={(count) => { setEditingSections(false); setError(''); setNotice(`已保存 ${count} 段结构，标记为人工校准。`); }}
        />
      )}
    </section>
  );
}
