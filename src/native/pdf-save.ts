import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * A4 学习稿 PDF 的原生落盘/分享桥（R3 P0）。
 *
 * WebView 里 `Blob → a[download]` 在 Capacitor 宿主中不会真正写文件，
 * 因此安卓端改走原生 MediaStore「下载」目录：文件管理器可见，返回值是真实 content:// 地址。
 * 浏览器端仍保留普通下载行为，由这里统一给出「是否原生」的判断。
 */

export interface SavedPdf {
  uri: string;
  name: string;
  path: string;
  size: number;
}

interface PdfSavePlugin {
  saveToDownloads(options: { fileName: string; base64: string }): Promise<SavedPdf>;
  share(options: { uri: string; title?: string }): Promise<void>;
  open(options: { uri: string }): Promise<void>;
}

const PdfSave = registerPlugin<PdfSavePlugin>('PdfSave');

export function isNativePdfSaveSupported(): boolean {
  return Capacitor.isNativePlatform();
}

/** 分块转 base64，避免大 PDF 一次性展开参数导致调用栈溢出。 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function savePdfToDownloads(bytes: Uint8Array, fileName: string): Promise<SavedPdf> {
  return PdfSave.saveToDownloads({ fileName, base64: toBase64(bytes) });
}

export async function shareSavedPdf(saved: SavedPdf, title: string): Promise<void> {
  if (saved.uri.startsWith('content://')) {
    await PdfSave.share({ uri: saved.uri, title });
    return;
  }
  throw new Error('NO_CONTENT_URI');
}

export async function openSavedPdf(saved: SavedPdf): Promise<void> {
  if (saved.uri.startsWith('content://')) {
    await PdfSave.open({ uri: saved.uri });
    return;
  }
  throw new Error('NO_CONTENT_URI');
}
