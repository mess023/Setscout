/**
 * Settings + data paths. Everything persistent lives in DATA_DIR (default ./data,
 * in Docker /data): settings.json, indexes per method, server-side exports.
 * API keys stay here; the UI only ever sees whether a key is set.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.SETSCOUT_DATA || join(ROOT, 'data');
export const INDEX_DIR = join(DATA_DIR, 'index');
export const EXPORT_DIR = process.env.SETSCOUT_EXPORT_DIR || join(DATA_DIR, 'exports');
const FILE = join(DATA_DIR, 'settings.json');

export function loadSettings() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export function saveSettings(s) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2));
}

export const indexDir = (id) => { const d = join(INDEX_DIR, id); mkdirSync(d, { recursive: true }); return d; };
export const hasSettingsFile = () => existsSync(FILE);
