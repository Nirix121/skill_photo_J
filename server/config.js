import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    const value = m[2].trim().replace(/^["'](.*)["']$/, '$1');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Не задана переменная ${name}. Скопируйте .env.example в .env и заполните (npm run secret сгенерирует значения).`,
    );
  }
  return v;
}

export const config = {
  root: ROOT,
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),

  // Публичный адрес — в него подставляются ссылки и QR-код на сертификате.
  siteUrl: (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, ''),

  // Секретный путь панели: домен.com/<panelPath>
  panelPath: required('PANEL_PATH').replace(/^\/+/, ''),

  sessionSecret: required('SESSION_SECRET'),
  sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_HOURS || 12) * 3600_000,

  // Сколько случайных цифр дописывается в адрес сертификата.
  codeDigits: Number(process.env.CODE_DIGITS || 30),

  folders: ['ldb', 'edb'],

  paths: {
    data: path.join(ROOT, 'data'),
    db: path.join(ROOT, 'data', 'app.db'),
    storage: path.join(ROOT, 'storage'),
    tmp: path.join(ROOT, 'data', 'tmp'),
    public: path.join(ROOT, 'public'),
    views: path.join(ROOT, 'server', 'views'),
  },

  uploads: {
    maxPhotoBytes: Number(process.env.MAX_PHOTO_MB || 10) * 1024 * 1024,
    maxDocBytes: Number(process.env.MAX_DOC_MB || 25) * 1024 * 1024,
  },
};

for (const dir of [config.paths.data, config.paths.storage, config.paths.tmp]) {
  fs.mkdirSync(dir, { recursive: true });
}
for (const folder of config.folders) {
  fs.mkdirSync(path.join(config.paths.storage, folder), { recursive: true });
}
