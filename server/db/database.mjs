import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(filename) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const root = new URL('./migrations/', import.meta.url);
  try {
    for (const file of readdirSync(root).filter(f => f.endsWith('.sql')).sort()) {
      if (db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(file)) continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(readFileSync(new URL(file, root), 'utf8'));
        db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(file);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    return db;
  } catch (error) { db.close(); throw error; }
}
