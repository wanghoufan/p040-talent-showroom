/**
 * 文件名归一与身份解析（V3.1 扫描器核心，逐条对齐计划包 tool/p040_smart_import.py）。
 *
 * 真实样本的事实依据 `var/vocal-v31-work/real-music-audit-deep.json`：
 * - T01 `3LAU, Carly Paige` 与 `3LAU,Carly Paige` 逗号后空格不同，必须归一为同一曲；
 * - T05 真实文件名是 `宝石Gem,俞天时,王洋EVIS`，清单写作 `宝石 Gem, ...`，空格差异必须归一；
 * - T08 真实文件名用全角括号 `（翻自 Shawn Mendes）`，必须归一且保留翻唱标识；
 * - `(1)` 是 Finder 副本后缀，必须剥离；`(8D Audio)` 是版本差异，必须保留。
 */

/** 可导入媒体扩展名（只读扫描，不转码）。 */
export const AUDIO_EXTENSIONS = Object.freeze(['.mp3', '.m4a', '.wav', '.flac']);
export const LYRICS_EXTENSIONS = Object.freeze(['.lrc']);
export const ALL_EXTENSIONS = Object.freeze([...AUDIO_EXTENSIONS, ...LYRICS_EXTENSIONS]);

/** 真正不同的版本：不得为自动配对而合并。 */
const VERSION_SOURCE =
  '\\b(?:8d(?:\\s+audio)?|live|remix|cover|radio\\s+edit|acoustic|sped\\s+up|slowed|nightcore|demo|instrumental)\\b|翻唱|翻自|现场版|混音版';
export const VERSION_PATTERN = new RegExp(VERSION_SOURCE, 'i');

/** Finder 副本后缀：`(1)`、`(12)`。 */
export const COPY_SUFFIX_PATTERN = /\s*\(([0-9]+)\)\s*$/;

/** 文件名尾部角色标记：伴奏 / 原唱。 */
const ROLE_END_PATTERN =
  /(?:\s*[-_. ]+\s*|\s*\()(?:伴奏|instrumental|karaoke|backing(?:[\s-]*track)?|原唱|原声|original|guide|vocals?)(?:\s*\))?$/i;
const ACCOMPANIMENT_PATTERN = /(?:伴奏|instrumental|karaoke|backing(?:[\s-]*track)?)/i;
const DASH_SEPARATOR = /\s+[-–—]\s+/;

/**
 * 归一：NFKC（全角括号/全角拉丁自动折叠）→ 小写 → 破折号统一 → 逗号/破折号两侧空格统一。
 * 只抹掉排版差异，不抹版本词（8D/Live/Remix/Cover/翻唱…）。
 */
export function canonical(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[–—－−]/g, '-')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 多歌手比较键：ID3 常用 `/` 分隔、文件名常用 `,`，顺序也可能不同。
 * 只用于“是否同一批歌手”的交叉核验，不用于展示。
 */
export function artistKey(value) {
  return [...new Set(
    canonical(String(value ?? '').replace(/[/;；、&]/g, ','))
      .split(',')
      .map(part => part.trim())
      .filter(Boolean),
  )].sort().join(',');
}

/** 取最后一个扩展名之前的 stem（等价 Python `Path(name).stem`）。 */
export function stemOf(fileName) {
  const name = String(fileName ?? '');
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(0, index) : name;
}

export function stripCopyNumber(stem) {
  return stem.replace(COPY_SUFFIX_PATTERN, '').trim();
}

/** 返回 `{ name, role }`；`role` 为 `accompaniment` / `original` / `unmarked`。 */
export function audioRole(stem) {
  const match = ROLE_END_PATTERN.exec(stem);
  if (!match) return { name: stem.trim(), role: 'unmarked' };
  const role = ACCOMPANIMENT_PATTERN.test(match[0]) ? 'accompaniment' : 'original';
  return { name: stem.slice(0, match.index).replace(/[ _.\\-]+$/, ''), role };
}

/** 版本标识列表（用于展示与“不得合并”判断），例如 `['8d audio']`、`['翻自']`。 */
export function versionLabels(text) {
  const pattern = new RegExp(VERSION_SOURCE, 'gi');
  const labels = new Set();
  for (const match of String(text ?? '').matchAll(pattern)) {
    labels.add(match[0].replace(/\s+/g, ' ').toLowerCase());
  }
  // `8D Tunes` 里的前缀 `8D` 与 `(8D Audio)` 是同一个版本标识，只保留最具体的那个。
  const all = [...labels];
  return all.filter(label => !all.some(other => other !== label && other.startsWith(`${label} `)));
}

/**
 * 展示用文字归一：NFKC 会把全角括号/全角拉丁折叠成半角，保留原始大小写与文案。
 * 只用于展示与匹配键，不改变磁盘上的真实文件名。
 */
function normalizeDisplay(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/([^\s(])\(/g, '$1 (');
}

/**
 * 文件名身份：artist/title 只用「两侧带空格的短横线」切分。
 * 无空格的短横线（如 `A-B`）不当作歌手/歌名分隔符。
 */
export function nameIdentity(fileName) {
  const stem = stemOf(fileName);
  const copyNumber = COPY_SUFFIX_PATTERN.exec(stem)?.[1] ?? '';
  const { name, role } = audioRole(normalizeDisplay(stripCopyNumber(stem)));
  const separator = DASH_SEPARATOR.exec(name);
  const artist = separator ? name.slice(0, separator.index) : '';
  const title = separator ? name.slice(separator.index + separator[0].length) : name;
  return {
    stem,
    base: name,
    artist: artist.trim(),
    title: title.trim(),
    artistKey: artistKey(artist),
    titleKey: canonical(title),
    key: canonical(name),
    role,
    copyNumber,
    // 版本标识只看歌名：歌手叫 `8D Tunes` 不等于这首歌是 8D 版本。
    versions: versionLabels(title),
  };
}

/**
 * LRC 署名行（`作词 : XXX`、`作曲 : XXX`…）不是歌词本体。
 * 网易云等来源常把它们写进歌词行（甚至带时戳），中文署名会把英文歌判成中文（BUG-V31-QA-004）。
 * `封面` 是真实样本 `石玺彤 - Let Go.lrc` 里出现过的署名行，同样不计入。
 */
export const CREDIT_LINE_PATTERN =
  /^(?:作词|作曲|编曲|词|曲|制作人|监制|出品|混音|母带|和声|录音|配唱|演唱|原唱|策划|企划|校对|翻译|文案|制作|封面)\s*[:：]|^(?:lyrics|composed|written|produced|arranged)\s*(?:by)?\s*[:：]/i;

/**
 * 取出这一行的歌词文本。
 * 真实样本里网易云逐字歌词长成 `{"t":0,"c":[{"tx":"作词: "},{"tx":"Justin Blau"},…]}`，
 * 直接拿整行判语言会把 JSON 键也算进去，所以把 `tx` 字段拼回纯文本。
 */
function lyricTextOf(line) {
  if (!line.includes('"tx"')) return line;
  const values = [...line.matchAll(/"tx"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(match => match[1]);
  return values.length ? values.join('') : line;
}

/** 书写系统字符类（全局正则，用于逐行统计字符数）。 */
const HANGUL_CHAR = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7A3\uD7B0-\uD7FF]/g;
const KANA_CHAR = /[\u3040-\u309F\u30A0-\u30FF\uFF66-\uFF9D]/g;
const HAN_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
const LATIN_CHAR = /[A-Za-z\u00C0-\u024F]/g;
const TIMESTAMP = /\[[^\]]*\]/g;

/**
 * 语言判定阈值（按“行”计数，不按字符数）。
 *
 * 依据 688 个真实 LRC（`/Volumes/三星/网易云音乐/音乐（用于转换）/`）的实测分布：
 * - 中文行占比：中文/粤语歌 0.70–1.00（最紧的是 `陈奕迅 - Lonely Christmas` 0.71，粤语原词 + 英文副歌）；
 *   中英双语（英文原词 + 中文翻译行交替，如 Senorita 中英文版、All Falls Down remix）稳定在 0.43–0.50；
 *   纯英文歌 0.00。
 * - 因此 `hanZh = 0.60` 取在两簇中间（距双语簇 0.10、距中文簇 0.10 的余量）：
 *   ≥ 0.60 判 zh；0.20–0.60 之间判为“双语”，交给拉丁/韩文侧决定；< 0.20（`hanMinZh`）只当零散中文词，不算中文。
 * - 韩文行占比（`hangulKo = 0.30`）：韩文歌 0.25–1.00，中文歌与英文歌均为 0.00（全库零例外），
 *   留出余量，并保证韩文歌里的中文/英文翻译行压不掉 ko。
 * - 假名行（`kanaUncertain = 0.20`）：只要两成行带假名就认为日文，返回 null 不猜（枚举里没有 ja）。
 * - `latinEn = 0.20`：双语带里的“非翻译侧”就是拉丁行，≥ 0.20 足以判定英文。
 */
export const LANG_LINE_THRESHOLDS = Object.freeze({
  hangulKo: 0.30,
  hanZh: 0.60,
  hanMinZh: 0.20,
  kanaUncertain: 0.20,
  latinEn: 0.20,
});

/** 单行写法归类：`ko` / `zh` / `en` / `ja` / null（无字母或无法归类）。 */
function classifyLine(text) {
  const hangul = (text.match(HANGUL_CHAR) ?? []).length;
  const kana = (text.match(KANA_CHAR) ?? []).length;
  const han = (text.match(HAN_CHAR) ?? []).length;
  const latin = (text.match(LATIN_CHAR) ?? []).length;
  // 混排行按“该行主要字符占比”归类；平手时按 ko > zh > en 优先，让韩文不被同行的拉丁借词稀释。
  if (kana > 0 && kana >= hangul && kana >= han && kana >= latin) return 'ja';
  if (hangul > 0 && hangul >= han && hangul >= latin) return 'ko';
  if (han > 0 && han >= latin) return 'zh';
  if (latin > 0) return 'en';
  return null;
}

/**
 * 网易云纯音乐占位行：`[00:05.00]纯音乐，请欣赏`。
 * 真实库里 78 个 LRC 只有这一行（没有人声），不是歌词，不能据此判中文。
 */
const INSTRUMENTAL_PLACEHOLDER = /^[纯純]音乐[，,、]?\s*请欣赏[。.!！]?$/;

/**
 * 逐行统计各书写系统的行数（供判定与排查共用，纯函数、不读文件）。
 * 只统计“可用歌词行”：去时戳后非空、且不是署名行/纯音乐占位行；纯符号/纯数字行不计。
 * 先去时戳再判署名，是因为真实 LRC 也会写成 `[00:00.00]作词 : XXX`。
 */
export function lyricScriptCounts(lyrics) {
  const counts = { ko: 0, zh: 0, en: 0, ja: 0, skipped: 0 };
  for (const raw of String(lyrics ?? '').split(/\r?\n/)) {
    const line = lyricTextOf(raw).replace(TIMESTAMP, '').normalize('NFKC').trim();
    if (!line) { counts.skipped += 1; continue; }
    if (CREDIT_LINE_PATTERN.test(line) || INSTRUMENTAL_PLACEHOLDER.test(line)) {
      counts.skipped += 1;
      continue;
    }
    const script = classifyLine(line);
    if (!script) { counts.skipped += 1; continue; }
    counts[script] += 1;
  }
  return counts;
}

/**
 * 语言判定：仅覆盖既有 vocal_language 枚举 zh / en / ko。
 *
 * 规则（V3.1 重写，只读歌词正文，`title`/`artist` 一律不参与）：
 * 调用方（scan.mjs）仍按 `{ title, artist, lyrics }` 传入，签名不变；这里刻意只解构 `lyrics`。
 * 1. 无可用歌词行 → null。**不回退到歌名/歌手猜**：中文歌手唱英文歌、英文歌名配中文歌手
 *    的元数据本身就是误判源（`王嘉尔 - Papillon`、`石玺彤 - Let Go`），宁可留空让人补。
 * 2. 韩文行占比 ≥ 0.30 → ko（优先于中英混排：韩文歌常夹中文翻译行）。
 * 3. 假名行占比 ≥ 0.20 → null（日文，枚举里没有 ja，不臆造）。
 * 4. 中文行占比 ≥ 0.60 → zh。
 * 5. 拉丁行占比 ≥ 0.20 → en（中英双语带 0.20–0.60 落到这里：翻译侧是中文，主语言是英文）。
 * 6. 中文行占比 ≥ 0.20 → zh（有中文但没有拉丁侧，例如中文歌少量韩文/符号行）。
 * 7. 其余 → null。
 */
export function detectLanguage({ lyrics = '' } = {}) {
  const counts = lyricScriptCounts(lyrics);
  const total = counts.ko + counts.zh + counts.en + counts.ja;
  if (total === 0) return null;
  const ratio = count => count / total;
  if (ratio(counts.ko) >= LANG_LINE_THRESHOLDS.hangulKo) return 'ko';
  if (ratio(counts.ja) >= LANG_LINE_THRESHOLDS.kanaUncertain) return null;
  if (ratio(counts.zh) >= LANG_LINE_THRESHOLDS.hanZh) return 'zh';
  if (ratio(counts.en) >= LANG_LINE_THRESHOLDS.latinEn) return 'en';
  if (ratio(counts.zh) >= LANG_LINE_THRESHOLDS.hanMinZh) return 'zh';
  return null;
}

export function isAudioFile(name) {
  const dot = String(name).lastIndexOf('.');
  return dot > 0 && AUDIO_EXTENSIONS.includes(String(name).slice(dot).toLowerCase());
}

export function isLyricsFile(name) {
  const dot = String(name).lastIndexOf('.');
  return dot > 0 && LYRICS_EXTENSIONS.includes(String(name).slice(dot).toLowerCase());
}
