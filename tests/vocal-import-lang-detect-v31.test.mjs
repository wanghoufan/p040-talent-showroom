/**
 * V3.1 语言判定重写（只读歌词正文 + 逐行投票）。
 *
 * 背景：旧实现把 `title + artist + 歌词` 拼成一个字符串后按脚本首命中，
 * 中文歌手唱英文歌（王嘉尔 - Papillon、石玺彤 - Let Go）与中英双语 LRC
 * （英文原词 + 中文翻译行）都会被判成 zh。这里用内联 LRC 片段覆盖七种情形，
 * 不依赖任何外部音乐文件。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, LANG_LINE_THRESHOLDS, lyricScriptCounts } from '../server/vocal-import/canonical.mjs';

/** 把若干句纯文本按 1 秒间隔包成最简 LRC。 */
function lrc(...lines) {
  return lines
    .map((text, index) => `[00:${String(index + 1).padStart(2, '0')}.00]${text}`)
    .join('\n');
}

test('纯中文歌词 → zh', () => {
  const lyrics = lrc('谁又骑着那鹿车飞过', '忘掉投下那礼物给我', '凝视那灯饰');
  assert.equal(detectLanguage({ lyrics }), 'zh');
  assert.deepEqual(
    { zh: lyricScriptCounts(lyrics).zh, en: lyricScriptCounts(lyrics).en },
    { zh: 3, en: 0 },
  );
});

test('纯英文歌词 → en', () => {
  const lyrics = lrc('You got me feeling like a', 'Feeling like a Papillon', "I'll shine like a diamond");
  assert.equal(detectLanguage({ lyrics }), 'en');
});

test('纯韩文歌词 → ko（夹英文副歌仍是 ko）', () => {
  const lyrics = lrc(
    '주변 사람들이 나보고 미친 것 같대',
    "Yeah I'm the female monster",
    '너도 날 보고 지금 좀 미칠 것 같대',
    "Everybody let's get crazy right now",
    '내가 왜 이러는지 나도 몰라',
    'Let go',
  );
  assert.equal(detectLanguage({ lyrics }), 'ko');
  const counts = lyricScriptCounts(lyrics);
  assert.equal(counts.ko, 3);
  assert.equal(counts.en, 3);
});

test('中英双语逐行交替 → en（翻译行不把主语言拉成 zh）', () => {
  // 真实样本 `刘至佳,Lambert凌杰 - Alan Walker-All Falls Down（remix）` 的结构：英文原词 + 中文翻译行。
  const lyrics = lrc(
    "What's the trick? I wish I knew",
    '爱的诀窍是什么 真希望我能懂',
    "I'm so done with thinking through all the things I could've been",
    '我受够了总是要去苦恼我本能完成的所有事',
    'And I know you wonder too',
    '我知道你也渴望着我',
  );
  const counts = lyricScriptCounts(lyrics);
  assert.equal(counts.en, 3);
  assert.equal(counts.zh, 3);
  // zh 行占比 0.5 落在 [0.20, 0.60) 的双语带 → 取非翻译侧（拉丁行）→ en。
  assert.equal(detectLanguage({ lyrics }), 'en');

  // 反向验证：中文占多数（中文歌夹英文副歌）仍必须判 zh，不能为压 zh 把中文歌判成 en。
  const cantonese = lrc(
    '谁又骑着那鹿车飞过',
    '忘掉投下那礼物给我',
    '凝视那灯饰',
    '只有今晚最光最亮',
    'Merry merry christmas',
    '明日灯饰必须拆下',
  );
  assert.equal(detectLanguage({ lyrics: cantonese }), 'zh');
});

test('中文歌手 / 中文歌名不得影响判定（元数据不参与）', () => {
  const lyrics = lrc('He used to be the center of your universe', 'So every time you talk you rehearse');
  assert.equal(detectLanguage({ title: 'Let Go', artist: '石玺彤', lyrics }), 'en');
  assert.equal(detectLanguage({ title: '放手吧', artist: '石玺彤, 王嘉尔', lyrics }), 'en');
  assert.equal(detectLanguage({ lyrics }), 'en');
  // 反过来：英文歌名 + 中文歌词仍是 zh，说明不是“讨厌中文元数据”，而是根本不看元数据。
  assert.equal(detectLanguage({ title: 'Lonely Christmas', artist: 'Eason Chan', lyrics: lrc('忘掉投下那礼物给我') }), 'zh');
});

test('无可用歌词行 → null，不退回去猜歌名/歌手', () => {
  assert.equal(detectLanguage({}), null);
  assert.equal(detectLanguage({ lyrics: '' }), null);
  assert.equal(detectLanguage({ title: 'Papillon', artist: '王嘉尔' }), null);
  // 只有署名行 / 空时戳行：不算歌词，也不回退元数据。
  assert.equal(detectLanguage({ title: 'Dumhdurum', artist: 'APINK', lyrics: lrc('作词 : 某某', '作曲 : 某某') }), null);
  assert.equal(detectLanguage({ title: 'Touch', lyrics: '[00:01.00]\n[00:02.00]' }), null);
  // 纯符号 / 纯数字行同样不计入。
  assert.equal(detectLanguage({ lyrics: lrc('***', '123456', '♪ ♪') }), null);
  // 网易云纯音乐占位行（真实库里 78 个 LRC 只有这一行）不是歌词，不能据此判 zh。
  assert.equal(detectLanguage({ title: '雪花', artist: '城之内ミサ', lyrics: lrc('纯音乐，请欣赏') }), null);
});

test('日文假名 → null（枚举里没有 ja，不臆造）', () => {
  const lyrics = lrc('夜に駆ける', '沈むように溶けてゆくように', '君の胸に響くように');
  assert.equal(detectLanguage({ title: '夜に駆ける', lyrics }), null);
  // 韩文歌里夹日文翻译行：只要假名行不足两成，仍按韩文判。
  const korean = lrc('사랑해', '愛してる', '보고 싶어', '기다려', '가지 마');
  assert.equal(detectLanguage({ lyrics: korean }), 'ko');
});

test('阈值是模块级常量，便于后续调参', () => {
  assert.equal(LANG_LINE_THRESHOLDS.hangulKo, 0.30);
  assert.equal(LANG_LINE_THRESHOLDS.hanZh, 0.60);
  assert.equal(LANG_LINE_THRESHOLDS.kanaUncertain, 0.20);
});
