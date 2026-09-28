import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { admins, certificates } from '../db.js';

/**
 * Проверка готовности к публичному запуску: `npm run check`.
 * Ничего не меняет, только смотрит и сообщает, что поправить.
 */

const problems = [];
const warnings = [];
const ok = [];

const check = (condition, good, bad, level = problems) =>
  condition ? ok.push(good) : level.push(bad);

// --- секреты ---------------------------------------------------------------

check(
  config.sessionSecret.length >= 32,
  'SESSION_SECRET достаточной длины',
  'SESSION_SECRET короче 32 символов — выполните npm run secret и замените',
);

check(
  config.panelPath.length >= 16,
  `Секретный путь панели задан (${config.panelPath.length} символов)`,
  'PANEL_PATH короче 16 символов — его слишком легко подобрать, смените на длинный',
);

check(
  !['admin', 'panel', 'login', 'wp-admin'].includes(config.panelPath.toLowerCase()),
  'Путь панели не угадывается с первой попытки',
  'PANEL_PATH — очевидное слово, его найдут сканером. Задайте случайный (npm run secret)',
);

// --- боевой режим ----------------------------------------------------------

if (config.env === 'production') {
  check(
    config.siteUrl.startsWith('https://'),
    'SITE_URL работает по HTTPS',
    'SITE_URL без https: cookie панели помечаются secure и по http не сохранятся — войти не выйдет',
  );
  check(
    process.env.TRUST_PROXY,
    'TRUST_PROXY задан — ограничения считают реальные IP',
    'TRUST_PROXY не задан. За nginx поставьте TRUST_PROXY=1, иначе все запросы выглядят как один адрес',
    warnings,
  );
} else {
  warnings.push(`NODE_ENV=${config.env}. Для боевого сервера поставьте production`);
}

check(
  !config.siteUrl.includes('localhost'),
  `Публичный адрес: ${config.siteUrl}`,
  `SITE_URL всё ещё ${config.siteUrl} — этот адрес попадёт в QR-код на сертификатах`,
  config.env === 'production' ? problems : warnings,
);

if (new URL(config.siteUrl).hostname.endsWith('.trycloudflare.com')) {
  warnings.push('Публичный адрес пока использует временный туннель. Для запуска нужен собственный домен и именованный Cloudflare Tunnel.');
}

// --- администратор ---------------------------------------------------------

check(
  admins.count() > 0,
  `Администраторов заведено: ${admins.count()}`,
  'Ни одного администратора — выполните npm run admin',
);

// --- файлы и права ---------------------------------------------------------

for (const folder of config.folders) {
  const dir = path.join(config.paths.storage, folder);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    ok.push(`Папка storage/${folder} доступна на запись`);
  } catch {
    problems.push(`Нет прав на запись в storage/${folder}`);
  }
}

try {
  fs.accessSync(config.paths.db, fs.constants.W_OK);
  ok.push('База доступна на запись');
} catch {
  problems.push(`Нет прав на запись в ${path.relative(config.root, config.paths.db)}`);
}

check(
  fs.existsSync(path.join(config.paths.public, 'fonts', 'nunito-sans-latin-400.woff2')),
  'Шрифт веб-страницы на месте',
  'Нет public/fonts/nunito-sans-latin-400.woff2 — на сервере без Avenir Next текст поедет',
  warnings,
);

check(
  !fs.existsSync(path.join(config.root, '.git')) ||
    fs.readFileSync(path.join(config.root, '.gitignore'), 'utf8').includes('.env'),
  'Файл .env не попадёт в репозиторий',
  '.env не закрыт в .gitignore — секреты утекут при первом же коммите',
);

// --- PDF ---

for (const face of ['Regular', 'SemiBold', 'Bold']) {
  check(
    fs.existsSync(path.join(config.root, 'server', 'fonts', `NunitoSans-${face}.ttf`)),
    `Шрифт NunitoSans-${face} доступен`,
    `Нет server/fonts/NunitoSans-${face}.ttf — печать PDF не сработает`,
  );
}

const sample = certificates.list({ limit: 1 }).rows[0];
if (sample) {
  try {
    const { renderCertificatePdf } = await import('../services/pdf.js');
    const pdf = await renderCertificatePdf(sample.slug);
    check(pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 1000,
      `PDF создаётся без браузера (${pdf.length} байт)`, 'Генератор вернул некорректный PDF');
  } catch (err) {
    problems.push(`PDF не создаётся: ${err.message.split('\n')[0]}`);
  }
} else {
  warnings.push('Нет сертификата для проверки PDF — проверьте печать после первого создания');
}

const total = certificates.stats().total;
ok.push(`Сертификатов в базе: ${total}`);

// --- вывод -----------------------------------------------------------------

const list = (title, items) => {
  if (!items.length) return;
  console.log(`\n${title}`);
  for (const item of items) console.log(`  ${item}`);
};

list('В порядке:', ok);
list('Обратите внимание:', warnings);
list('Нужно исправить:', problems);

console.log(
  problems.length
    ? `\nК публичному запуску не готово: ${problems.length} замечани(е/я).\n`
    : '\nПроверки приложения пройдены; развертывание и домен проверьте отдельно.\n',
);

process.exit(problems.length ? 1 : 0);
