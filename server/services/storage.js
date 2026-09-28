import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Каждый сертификат — своя папка внутри ldb или edb.
 * Удаление папки освобождает адрес: сертификат по нему больше не открывается.
 */
export function certDir(folder, slug) {
  if (!config.folders.includes(folder)) throw new Error(`Неизвестная папка: ${folder}`);
  if (!/^[0-9a-z]+$/i.test(slug)) throw new Error(`Некорректный адрес: ${slug}`);
  return path.join(config.paths.storage, folder, slug);
}

export function ensureCertDir(folder, slug) {
  const dir = certDir(folder, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveFile(folder, slug, filename, buffer) {
  const dir = ensureCertDir(folder, slug);
  fs.writeFileSync(path.join(dir, filename), buffer);
  return filename;
}

export function filePath(folder, slug, filename) {
  return path.join(certDir(folder, slug), path.basename(filename));
}

export function fileExists(folder, slug, filename) {
  return Boolean(filename) && fs.existsSync(filePath(folder, slug, filename));
}

export function removeFile(folder, slug, filename) {
  if (!filename) return;
  fs.rmSync(filePath(folder, slug, filename), { force: true });
}

export function removeCertDir(folder, slug) {
  fs.rmSync(certDir(folder, slug), { recursive: true, force: true });
}

/** Безопасное имя файла для вложения: без путей и служебных символов. */
export function safeFilename(original, fallback) {
  const base = path.basename(String(original || '')).replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : fallback;
}
