import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db/database.mjs';
import { getRepertoire, saveRepertoire } from '../server/repertoire/service.mjs';
import { createVocalTranslationService } from '../server/vocal-translation/service.mjs';
import {
  associateExistingTranslations, mergeTranslations, splitBilingualLrc,
} from '../server/vocal-translation/translation.mjs';

const LYRICS = [
  { id: 'line-1', startMs: 1000, text: '내가 달리는 길은' },
  { id: 'line-2', startMs: 3000, text: '허나 그 길엔 온통 덫' },
  { id: 'line-3', startMs: 5000, text: '피할 수 없는 함정' },
];

function fakeTranslator(overrides = {}) {
  return {
    kind: 'fake', provider: 'fake', model: 'fake-model', description: '测试用假通道',
    available: true,
    calls: [],
    async translateBatch(texts, { sourceLanguage } = {}) {
      this.calls.push({ texts: [...texts], sourceLanguage });
      const failed = texts.find(text => overrides.failText && text.includes(overrides.failText));
      if (failed) throw Object.assign(new Error(overrides.code || 'PROVIDER_FAILED'), { code: overrides.code || 'PROVIDER_FAILED' });
      return texts.map(text => `${overrides.prefix || '译：'}${text}`);
    },
  };
}

let directory;
let db;

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'p040-translation-'));
  db = openDatabase(join(directory, 'qa.db'));
});
after(() => {
  db?.close();
  rmSync(directory, { recursive: true, force: true });
});
// 每个用例独立缓存，避免跨用例命中把「通道是否被调用」测成假绿。
beforeEach(() => { db.exec('DELETE FROM vocal_translation_cache'); });

function createSong(suffix, extra = {}) {
  return saveRepertoire(db, null, {
    kind: 'VOCAL', title: `测试歌-${suffix}`, language: 'ko', lyrics: LYRICS,
    ...extra,
  });
}

describe('LRC 双语拆行与译文合并', () => {
  it('同时间戳的韩中双语行拆成原文 + LRC 译文，时间轴不变', () => {
    const { lines, translations } = splitBilingualLrc([
      { startMs: 1000, text: '내가 달리는 길은' },
      { startMs: 1000, text: '我奔跑的那条路' },
      { startMs: 3000, text: '허나 그 길엔 온통 덫' },
      { startMs: 3000, text: '然而那条路上满是陷阱' },
    ], 'ko');
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(line => line.startMs), [1000, 3000]);
    assert.deepEqual(translations, ['我奔跑的那条路', '然而那条路上满是陷阱']);
  });

  it('中文歌不拆行，英文歌同样按邻近时间配对', () => {
    const zh = splitBilingualLrc([{ startMs: 0, text: '中文原词' }, { startMs: 0, text: '另一句' }], 'zh');
    assert.equal(zh.lines.length, 2);
    assert.deepEqual(zh.translations, []);
    const en = splitBilingualLrc([
      { startMs: 1000, text: 'Hold me tight' },
      { startMs: 1300, text: '抱紧我' },
    ], 'en');
    assert.equal(en.lines.length, 1);
    assert.deepEqual(en.translations, ['抱紧我']);
  });

  it('已入库的双语行只关联不删除', () => {
    const pairs = associateExistingTranslations([
      { id: 'line-1', startMs: 1000, text: '내가 달리는 길은' },
      { id: 'line-2', startMs: 1000, text: '我奔跑的那条路' },
    ], 'ko');
    assert.deepEqual(pairs.map(pair => [pair.id, pair.text]), [['line-1', '我奔跑的那条路']]);
  });

  it('AI 不覆盖人工，LRC 可以覆盖 AI', () => {
    const existing = [{ id: 'a', text: '人工', source: 'manual' }, { id: 'b', text: 'AI', source: 'ai' }];
    const merged = mergeTranslations(existing, [
      { id: 'a', text: 'AI 想改', source: 'ai' },
      { id: 'b', text: 'LRC 证据', source: 'lrc' },
    ]);
    assert.equal(merged.find(line => line.id === 'a').text, '人工');
    assert.equal(merged.find(line => line.id === 'b').text, 'LRC 证据');
  });
});

describe('批量翻译服务', () => {
  it('中文歌曲显式 NOTHING_TO_DO，不调用通道、不查缓存、不写库', async () => {
    const song = createSong('zh', {
      language: 'zh',
      lyrics: [
        { id: 'line-1', startMs: 0, text: '第一句中文' },
        { id: 'line-2', startMs: 2000, text: '第二句中文' },
      ],
    });
    const translator = fakeTranslator();
    const service = createVocalTranslationService({ db, translator });
    const result = await service.translateSong(song.id);

    assert.equal(result.status, 'NOTHING_TO_DO');
    assert.equal(result.skipped, true);
    assert.equal(result.remaining, 0);
    assert.equal(result.total, 0);
    assert.equal(translator.calls.length, 0, '中文歌绝不允许调用翻译通道');
    const saved = getRepertoire(db, song.id);
    assert.equal(saved.translations, undefined, '中文歌不得写译文');
    assert.deepEqual(saved.lyrics.map(line => line.text), ['第一句中文', '第二句中文']);
    assert.equal(saved.revision, song.revision, '跳过翻译不得推进 revision');
  });

  it('逐行翻译并保存，原文时间轴一个字节都不改', async () => {
    const song = createSong('basic');
    const translator = fakeTranslator();
    const service = createVocalTranslationService({ db, translator });
    const result = await service.translateSong(song.id);
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.translated, 3);
    assert.equal(result.remaining, 0);
    const saved = getRepertoire(db, song.id);
    assert.deepEqual(saved.lyrics.map(line => [line.id, line.startMs, line.text]), LYRICS.map(line => [line.id, line.startMs, line.text]));
    assert.deepEqual(saved.translations.lines.map(line => [line.id, line.text, line.source]), [
      ['line-1', '译：내가 달리는 길은', 'ai'],
      ['line-2', '译：허나 그 길엔 온통 덫', 'ai'],
      ['line-3', '译：피할 수 없는 함정', 'ai'],
    ]);
  });

  it('第二次不再调用通道；另一首同文歌曲命中缓存', async () => {
    const first = createSong('cache-a');
    const translator = fakeTranslator();
    const service = createVocalTranslationService({ db, translator });
    await service.translateSong(first.id);
    const callCount = translator.calls.length;
    const again = await service.translateSong(first.id);
    assert.equal(again.status, 'NOTHING_TO_DO');
    assert.equal(translator.calls.length, callCount);

    const second = createSong('cache-b');
    const cached = await service.translateSong(second.id);
    assert.equal(cached.status, 'COMPLETE');
    assert.equal(cached.translated, 0);
    assert.equal(cached.cached + cached.lrcReused, 3);
    assert.equal(translator.calls.length, callCount, '缓存命中不应再打通道');
  });

  it('同一句跨批出现时只翻一次，所有同文行拿到完全相同的译文', async () => {
    const repeated = '같은 후렴';
    const lyrics = [
      { id: 'line-1', startMs: 0, text: repeated },
      ...Array.from({ length: 35 }, (_, index) => ({ id: `line-${index + 2}`, startMs: (index + 1) * 1000, text: `가사 ${index + 1}` })),
      ...Array.from({ length: 34 }, (_, index) => ({ id: `line-${index + 37}`, startMs: (index + 40) * 1000, text: repeated })),
    ];
    const song = createSong('dedupe', { lyrics });
    let round = 0;
    const translator = {
      kind: 'fake', provider: 'fake', model: 'fake-model', description: '', available: true, calls: [],
      async translateBatch(texts) {
        round += 1;
        this.calls.push({ round, texts: [...texts] });
        // 不同批次给不同前缀：若同一句被拆到两批各自翻译，同文行的译文就会分叉。
        return texts.map(text => `R${round}：${text}`);
      },
    };
    const result = await createVocalTranslationService({ db, translator }).translateSong(song.id);

    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.total, 70);
    assert.equal(result.translated, 70);
    assert.equal(translator.calls.flatMap(call => call.texts).filter(text => text === repeated).length, 1, '同文只送通道一次');

    const saved = getRepertoire(db, song.id);
    const repeatedTexts = saved.translations.lines
      .filter(line => lyrics.find(lyric => lyric.id === line.id).text === repeated)
      .map(line => line.text);
    assert.equal(repeatedTexts.length, 35);
    assert.equal(new Set(repeatedTexts).size, 1, '同源重复行必须完全一致');
  });

  it('制作署名与段落标记不送通道、不算缺译文', async () => {
    const song = createSong('credit', {
      lyrics: [
        { id: 'line-1', startMs: 0, text: 'Chorus：김보아' },
        { id: 'line-2', startMs: 100, text: 'All Programming by：新沙洞老虎' },
        { id: 'line-3', startMs: 200, text: '[Verse 1]' },
        { id: 'line-4', startMs: 300, text: '오늘 하루도' },
      ],
    });
    const translator = fakeTranslator();
    const result = await createVocalTranslationService({ db, translator }).translateSong(song.id);
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.total, 1, '署名与段落标记不计入待译总数');
    assert.equal(result.remaining, 0);
    assert.deepEqual(translator.calls.flatMap(call => call.texts), ['오늘 하루도']);
    assert.deepEqual(getRepertoire(db, song.id).translations.lines.map(line => line.id), ['line-4']);
  });

  it('人工译文不被后续 AI 翻译覆盖，新句照常补齐', async () => {
    const song = createSong('manual');
    const translator = fakeTranslator();
    const service = createVocalTranslationService({ db, translator });
    service.applyManual(song.id, { lines: [{ id: 'line-2', text: '我的人工译文' }] });
    const nextLyrics = [...LYRICS, { id: 'line-4', startMs: 7000, text: '새로운 한 줄' }];
    saveRepertoire(db, song.id, { lyrics: nextLyrics });
    const result = await service.translateSong(song.id);
    assert.equal(result.status, 'COMPLETE');
    const saved = getRepertoire(db, song.id);
    const manual = saved.translations.lines.find(line => line.id === 'line-2');
    assert.equal(manual.text, '我的人工译文');
    assert.equal(manual.source, 'manual');
    assert.equal(saved.translations.lines.find(line => line.id === 'line-4').source, 'ai');
  });

  it('LRC 自带译文优先复用，不送通道', async () => {
    const song = createSong('lrc', {
      lyrics: [
        { id: 'line-1', startMs: 1000, text: '내가 달리는 길은' },
        { id: 'line-2', startMs: 1000, text: '我奔跑的那条路' },
        { id: 'line-3', startMs: 3000, text: '허나 그 길엔 온통 덫' },
      ],
    });
    const translator = fakeTranslator();
    const service = createVocalTranslationService({ db, translator });
    const result = await service.translateSong(song.id);
    assert.equal(result.lrcReused, 1);
    const saved = getRepertoire(db, song.id);
    assert.equal(saved.translations.lines.find(line => line.id === 'line-1').source, 'lrc');
    assert.deepEqual(translator.calls.flatMap(call => call.texts), ['허나 그 길엔 온통 덫']);
  });

  it('单句失败会二分重试并只记录失败句，不把整首标成完成', async () => {
    const song = createSong('fail');
    const translator = fakeTranslator({ failText: '덫' });
    const service = createVocalTranslationService({ db, translator });
    const result = await service.translateSong(song.id);
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.remaining, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].id, 'line-2');
    const saved = getRepertoire(db, song.id);
    assert.equal(saved.translations.lines.length, 2);
    assert.ok(!saved.translations.lines.some(line => line.id === 'line-2'));
  });

  it('通道级超时不二分空转，直接按句失败', async () => {
    const song = createSong('timeout');
    const translator = fakeTranslator({ failText: '덫', code: 'PROVIDER_TIMEOUT' });
    const service = createVocalTranslationService({ db, translator });
    const result = await service.translateSong(song.id);
    assert.equal(result.status, 'CHANNEL_UNAVAILABLE');
    assert.equal(result.failed.length, 3);
    assert.equal(translator.calls.length, 1, '整批超时只调用一次，不拆成多批');
  });

  it('通道不可用时仍复用本地缓存，已译句不会跟着通道一起丢', async () => {
    const first = createSong('cache-offline-a');
    const translator = fakeTranslator();
    await createVocalTranslationService({ db, translator }).translateSong(first.id);
    const calls = translator.calls.length;

    // 通道断开（脚本缺失/被禁用）后，另一首同文歌曲应当靠缓存补齐，而不是报「不可用」。
    translator.available = false;
    const second = createSong('cache-offline-b');
    const result = await createVocalTranslationService({ db, translator }).translateSong(second.id);
    assert.equal(translator.calls.length, calls, '通道不可用时不允许再调用');
    assert.equal(result.cached, 3);
    assert.equal(result.remaining, 0);
    assert.equal(result.status, 'COMPLETE');
    assert.equal(getRepertoire(db, second.id).translations.lines.length, 3);
  });

  it('老双语 LRC 里没配上的中文行既不算缺译文，也不会被当成原文送通道', async () => {
    const song = createSong('bilingual-stray', {
      lyrics: [
        { id: 'line-1', startMs: 1000, text: '내가 달리는 길은' },
        { id: 'line-2', startMs: 5500, text: '（舞台提示）' },
        { id: 'line-3', startMs: 9000, text: '허나 그 길엔 온통 덫' },
      ],
    });
    const translator = fakeTranslator();
    const result = await createVocalTranslationService({ db, translator }).translateSong(song.id);
    assert.equal(result.total, 2, '中文行已经是译文，不计入待译总数');
    assert.equal(result.remaining, 0);
    assert.deepEqual(translator.calls.flatMap(call => call.texts), ['내가 달리는 길은', '허나 그 길엔 온통 덫']);
    assert.equal(getRepertoire(db, song.id).translations.lines.length, 2);
  });

  it('长歌词按批翻译：120 句全部落库，不丢句、不重复、时间轴不动', async () => {
    const long = Array.from({ length: 120 }, (_, index) => ({
      id: `line-${index + 1}`,
      startMs: index * 2000,
      text: `가사 ${index + 1}`,
    }));
    const song = createSong('long', { lyrics: long });
    const translator = fakeTranslator();
    const result = await createVocalTranslationService({ db, translator }).translateSong(song.id);

    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.total, 120);
    assert.equal(result.translated, 120);
    assert.equal(result.remaining, 0);
    // 默认每批 32 句：120 句必须切成 4 批，且没有任何一批超量。
    assert.equal(translator.calls.length, 4);
    assert.ok(translator.calls.every(call => call.texts.length <= 32));

    const saved = getRepertoire(db, song.id);
    assert.equal(saved.translations.lines.length, 120);
    assert.equal(new Set(saved.translations.lines.map(line => line.id)).size, 120, '不能出现重复行');
    assert.deepEqual(saved.lyrics.map(line => [line.id, line.startMs, line.text]), long.map(line => [line.id, line.startMs, line.text]));
  });

  it('批量翻译过程中人工改的译文，不会被这一批的入口快照回滚', async () => {
    const song = createSong('race');
    const service0 = createVocalTranslationService({ db, translator: fakeTranslator() });
    service0.applyManual(song.id, { lines: [{ id: 'line-1', text: '旧的人工译文' }] });

    let service;
    let patched = false;
    const translator = {
      kind: 'fake', provider: 'fake', model: 'fake-model', description: '', available: true,
      async translateBatch(texts) {
        // 翻译进行中，用户在校对页把第 1 句改成了新的人工译文。
        if (!patched) {
          patched = true;
          service.applyManual(song.id, { lines: [{ id: 'line-1', text: '新的人工译文' }] });
        }
        return texts.map(text => `译：${text}`);
      },
    };
    service = createVocalTranslationService({ db, translator });
    await service.translateSong(song.id);

    const saved = getRepertoire(db, song.id).translations.lines;
    assert.equal(saved.find(line => line.id === 'line-1').text, '新的人工译文');
    assert.equal(saved.find(line => line.id === 'line-1').source, 'manual');
    assert.equal(saved.find(line => line.id === 'line-2').source, 'ai');
  });

  it('通道不可用时明确报不可用，不写假译文', async () => {
    const song = createSong('offline');
    const translator = fakeTranslator();
    translator.available = false;
    translator.unavailableReason = () => '测试：通道未配置';
    const service = createVocalTranslationService({ db, translator });
    const result = await service.translateSong(song.id);
    assert.equal(result.status, 'CHANNEL_UNAVAILABLE');
    assert.equal(result.remaining, 3);
    assert.equal(result.translated, 0);
    assert.equal(getRepertoire(db, song.id).translations, undefined);
  });

  it('人工纠错空文本只删除该句', async () => {
    const song = createSong('delete');
    const translator = fakeTranslator();
    const service = createVocalTranslationService({ db, translator });
    await service.translateSong(song.id);
    service.applyManual(song.id, { lines: [{ id: 'line-1', text: '' }] });
    const saved = getRepertoire(db, song.id);
    assert.deepEqual(saved.translations.lines.map(line => line.id), ['line-2', 'line-3']);
  });

  it('歌词改动后旧译文保留但标记原文已改', async () => {
    const song = createSong('stale');
    const translator = fakeTranslator();
    const service = createVocalTranslationService({ db, translator });
    await service.translateSong(song.id);
    const changed = LYRICS.map(line => line.id === 'line-1' ? { ...line, text: '내가 달리는 길은 (수정)' } : line);
    saveRepertoire(db, song.id, { lyrics: changed });
    const saved = getRepertoire(db, song.id);
    assert.equal(saved.translations.lines.find(line => line.id === 'line-1').stale, true);
  });
});
