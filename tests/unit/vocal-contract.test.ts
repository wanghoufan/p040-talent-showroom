import { describe, expect, it } from 'vitest';
import {
  canonicalImportNames, groupVocalFiles, guessLocalFileRole, normalizedSongKey,
  resolveTracks, trackPairStatus, uniqueTrackMedia, vocalFieldsFromImport, normalizeImportLanguage,
} from '../../src/lib/vocal';
import type { MediaFile, TalentItem, VocalLanguage, VocalTracks } from '../../src/lib/types';

const media = (id: string, extra: Partial<MediaFile> = {}): MediaFile => ({ id, url: `/api/media/audio/${id}`, sha256: `hash-${id}`, sizeBytes: 100, version: 1, ...extra });

describe('AI 智能导入统一契约', () => {
  it('一首歌的原唱/伴奏/LRC 归入同一候选，不当成三首歌', () => {
    const groups = groupVocalFiles(['夜航 原唱.mp3', '夜航 伴奏.mp3', '夜航.lrc', '另一首.mp3']);
    expect(groups).toHaveLength(2);
    const nocturne = groups.find(group => group.songKey === normalizedSongKey('夜航.mp3'))!;
    expect(nocturne).toMatchObject({ original: '夜航 原唱.mp3', accompaniment: '夜航 伴奏.mp3', lyrics: '夜航.lrc' });
    expect(nocturne.needsReview).toEqual([]);
  });

  it('未标注用途的音轨要求人工确认，同名重复文件进入待复核而不是静默合并', () => {
    expect(guessLocalFileRole('随便一个.mp3')).toEqual({ baseName: '随便一个', role: 'unknown' });
    const [bundle] = groupVocalFiles(['歌.mp3', '歌.flac', '歌.lrc']);
    expect(bundle.original).toBe('歌.mp3');
    expect(bundle.needsReview).toContain('同一首歌有多个原唱文件');
    expect(bundle.needsReview).toContain('音轨用途未标注，需要智能识别或确认');
  });

  it('内部命名稳定且拒绝非法 songId', () => {
    expect(canonicalImportNames('abc-123')).toEqual({ original: 'abc-123.original.mp3', accompaniment: 'abc-123.accompaniment.mp3', lyrics: 'abc-123.lrc', analysis: 'abc-123.analysis.json' });
    expect(() => canonicalImportNames('歌曲')).toThrow('无效歌曲 ID');
  });

  it('导入结果只带后端认可的语言，未知语言交给人工确认', () => {
    expect(normalizeImportLanguage('KO')).toBe('ko');
    expect(normalizeImportLanguage('fr')).toBeUndefined();
    const fields = vocalFieldsFromImport({
      songId: 'song', title: '夜航', artist: '自己', language: 'fr' as VocalLanguage,
      tracks: { original: { media: media('o') }, accompaniment: { media: media('a') } },
      needReview: ['语言未识别'],
    });
    expect(fields.language).toBeUndefined();
    expect(fields.tracks?.original?.media.id).toBe('o');
    expect(fields.lyrics).toBeUndefined();
  });
});

describe('有效音轨与旧字段兼容', () => {
  const legacy = (audioRole: 'REFERENCE' | 'ACCOMPANIMENT'): TalentItem => ({
    id: 'song', kind: 'VOCAL', title: '旧单轨', artist: '', learningStatus: 'WANT_TO_LEARN',
    originalKey: '', performanceKey: '', capo: 0, scoreText: '', notes: '', durationMs: 0,
    audioRole, audio: media('legacy'),
  });

  it('旧单音轨只落到 audioRole 对应的一轨，另一轨保持缺失', () => {
    expect(Object.keys(resolveTracks(legacy('REFERENCE')))).toEqual(['original']);
    expect(Object.keys(resolveTracks(legacy('ACCOMPANIMENT')))).toEqual(['accompaniment']);
  });

  it('服务端 tracks 是真源，旧 audio 指向同一媒体时不重复成为另一轨', () => {
    const tracks: VocalTracks = { accompaniment: { media: media('a') } };
    expect(resolveTracks({ ...legacy('ACCOMPANIMENT'), tracks })).toEqual(tracks);
    const both: VocalTracks = { original: { media: media('o', { url: '/api/media/audio/shared' }) }, accompaniment: { media: media('a', { url: '/api/media/audio/shared' }) } };
    expect(resolveTracks({ ...legacy('REFERENCE'), tracks: both })).toEqual(both);
  });

  it('吉他不读取唱歌音轨', () => {
    expect(resolveTracks({ ...legacy('REFERENCE'), kind: 'GUITAR' })).toEqual({});
  });

  it('双轨一致性：同媒体、单轨、时长偏差过大都要能识别', () => {
    expect(trackPairStatus({}).state).toBe('missing');
    expect(trackPairStatus({ original: { media: media('o') } }).state).toBe('one-track');
    expect(trackPairStatus({ original: { media: media('same') }, accompaniment: { media: media('other', { url: '/api/media/audio/same' }) } }).state).toBe('same-media');
    expect(trackPairStatus({ original: { media: media('o', { durationMs: 200000 }) }, accompaniment: { media: media('a', { durationMs: 180000 }) } }).state).toBe('needs-alignment');
    // offsetMs 抵消后的有效时长一致，视为已对齐。
    expect(trackPairStatus({ original: { media: media('o', { durationMs: 200000 }) }, accompaniment: { media: media('a', { durationMs: 197000 }), offsetMs: -3000 } }).state).toBe('ready');
  });

  it('同一媒体只缓存一次，但两条轨都保留', () => {
    const shared = { original: { media: media('o', { url: '/api/media/audio/x' }) }, accompaniment: { media: media('a') } };
    expect(uniqueTrackMedia(shared).map(item => item.id)).toEqual(['a', 'o']);
    expect(uniqueTrackMedia({ original: { media: media('o', { url: '/api/media/audio/x' }) }, accompaniment: { media: media('o2', { url: '/api/media/audio/x' }) } })).toHaveLength(1);
  });
});
