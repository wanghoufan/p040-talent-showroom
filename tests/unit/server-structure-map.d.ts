/**
 * 测试用：server/vocal-structure 的核心是纯 ESM（无类型声明），
 * 前端一致性用例直接引用它，避免「界面说能存、后端说非法」。
 */
declare module '*server/vocal-structure/structure-map.mjs' {
  export interface ServerSection {
    id: string;
    type: 'intro' | 'verse' | 'pre' | 'chorus' | 'bridge' | 'rap' | 'outro' | 'unknown';
    code: string; label: string; startMs: number; endMs: number;
    source: 'manual' | 'algorithm';
    repeatOf?: string; repetition?: 'exact-lyrics' | 'same-melody-new-lyrics' | 'unverified';
    lines?: { id: string; text: string; startMs: number }[];
  }
  export interface ServerMap {
    schema: string; songId: string; durationMs: number; status: string;
    sections: ServerSection[]; relationCandidates: unknown[]; warnings: string[];
  }
  export function buildSongMap(input: {
    songId?: string; durationMs: number; modelSegments: { start: number; end: number; label?: string }[];
    lyrics?: { id?: string; startMs: number; text: string }[]; audioEvidence?: unknown[];
  }): ServerMap;
  export function splitAtTime(map: ServerMap, id: string, atMs: number): ServerMap;
  export function mergeAdjacent(map: ServerMap, leftId: string, rightId: string, chosenType?: string): ServerMap;
  export function changeType(map: ServerMap, id: string, type: string): ServerMap;
  export function toP040Sections(map: ServerMap, options?: { confirmed?: boolean }): { source: string; label: string }[];
}
