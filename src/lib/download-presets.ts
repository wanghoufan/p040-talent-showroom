import { storedCatalog } from './catalog-store';
import { storedRepertoire } from './repertoire-store';
import { storedProgram } from './program';
import type { DanceItem, OfflineManifest, TalentItem } from './types';

/** 曲目是否属于「唱歌 / 舞蹈」：舞蹈没有 kind 字段，唱歌是 VOCAL，吉他排除。 */
function isSongOrDance(item: DanceItem | TalentItem): boolean {
  return !('kind' in item) || item.kind === 'VOCAL';
}

/** 以清单为准，清单缺失时退回手机里的快照，保证离线也能算出歌单。 */
export function catalogItems(manifest?: OfflineManifest | null): (DanceItem | TalentItem)[] {
  const dances = manifest?.items?.length ? manifest.items : storedCatalog();
  const repertoire = manifest?.repertoire?.length ? manifest.repertoire : storedRepertoire();
  return [...dances, ...repertoire];
}

/** 想学歌单：learningStatus==='WANT_TO_LEARN' 的唱歌 / 舞蹈曲目（不含吉他）。 */
export function wantToLearnIds(manifest?: OfflineManifest | null): string[] {
  return catalogItems(manifest).filter(item => item.learningStatus === 'WANT_TO_LEARN' && isSongOrDance(item)).map(item => item.id);
}

/** 今晚节目单：当前节目单里的全部曲目（含吉他），顺序保持不变。 */
export function tonightProgramIds(): string[] {
  return storedProgram().items.map(ref => ref.id);
}
