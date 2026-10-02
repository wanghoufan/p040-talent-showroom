import { resolve } from 'node:path';
export function readConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1', port: Number(env.PORT || 8791),
    dbPath: resolve(env.SQLITE_DB_PATH || 'var/personal-dance-library.db'),
    mediaRoot: resolve(env.MEDIA_ROOT || 'var/media'),
    recognition: env.MUSIC_RECOGNITION_PROVIDER || 'disabled',
  };
}
