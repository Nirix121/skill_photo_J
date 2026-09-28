import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

/**
 * Резервная копия: база и файлы сертификатов. База копируется через VACUUM INTO —
 * это безопасно на работающем сервере, останавливать сайт не нужно.
 *
 *   npm run backup                 -> ./backups/2026-09-22T2130
 *   npm run backup -- /mnt/backup  -> каталог задан вручную
 */

const KEEP = Number(process.env.BACKUP_KEEP || 30);
if (!Number.isInteger(KEEP) || KEEP < 1) throw new Error('BACKUP_KEEP must be a positive integer');
const root = process.argv[2] || path.join(config.root, 'backups');
const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '');
const target = path.join(root, stamp);

fs.mkdirSync(target, { recursive: true });

const db = new DatabaseSync(config.paths.db, { readOnly: true });
db.exec(`VACUUM INTO '${path.join(target, 'app.db').replace(/'/g, "''")}'`);
db.close();

fs.cpSync(config.paths.storage, path.join(target, 'storage'), { recursive: true });
for (const entry of ['server', 'public', 'deploy', 'tests', 'package.json', 'package-lock.json', 'README.md', '.gitignore', '.env.example']) {
  const from = path.join(config.root, entry);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(target, entry), { recursive: true });
}

const size = (dir) =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .reduce((sum, e) => sum + fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size, 0);

console.log(`Копия готова: ${target} (${(size(target) / 1048576).toFixed(1)} МБ)`);

// Чистим старые копии, чтобы диск не заполнился.
const old = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{4,6}$/.test(e.name))
  .map((e) => e.name)
  .sort()
  .slice(0, -KEEP);

for (const dir of old) {
  fs.rmSync(path.join(root, dir), { recursive: true, force: true });
  console.log(`Удалена старая копия: ${dir}`);
}
