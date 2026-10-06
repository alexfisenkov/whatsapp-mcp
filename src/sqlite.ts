import { chmodSync, lstatSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openPrivateDatabase(databasePath: string): DatabaseSync {
  const path = resolve(databasePath);
  const directory = dirname(path);
  const directoryStat = statSync(directory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
    throw new Error('SQLite state directory must exist and be private (mode 0700).');
  }
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('SQLite database path must not be a symlink.');
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }

  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
