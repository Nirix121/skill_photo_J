import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { sessionMiddleware } from './session.js';
import { db, admins } from './db.js';
import { panelRouter } from './routes/panel.js';
import { verifyRouter } from './routes/verify.js';

const app = express();

if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.set('view engine', 'ejs');
app.set('views', config.paths.views);
app.set('x-powered-by', false);
app.locals.panelUrl = `/${config.panelPath}`;
app.locals.siteUrl = config.siteUrl;

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Лист сертификата свёрстан инлайновыми стилями — это часть макета.
        // Шрифты и картинки лежат у нас же, наружу страница не ходит никуда.
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: config.env === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
);

app.use(express.json({ limit: '256kb' }));

/** Log only server-defined route patterns, never bearer URLs or query strings. */
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const route = typeof req.route?.path === 'string' ? req.route.path : '<static-or-unmatched>';
    console.log(
      `${new Date().toISOString()} ${req.method} ${route} ${res.statusCode} ${Date.now() - started}ms`,
    );
  });
  next();
});

app.use(sessionMiddleware);

app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

const temporaryHost = new URL(config.siteUrl).hostname.endsWith('.trycloudflare.com');

// Главная страница доступна без авторизации. Полный проверочный код остаётся
// секретом сертификата; номер сертификата не используется для поиска.
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (temporaryHost) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.render('home', { error: null });
});

const checkLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).render('home', {
    error: 'Too many attempts. Please try again in a few minutes.',
  }),
});

function verificationCode(input) {
  const value = String(input || '').trim();
  if (!value || value.length > 512) return null;
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    try { path = new URL(value).pathname; } catch { return null; }
  }
  const match = path.match(/^(?:\/verify\/)?([a-z0-9]{16,128})\/?$/i);
  return match?.[1] || null;
}

app.post('/check', checkLimiter, express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (temporaryHost) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const code = verificationCode(req.body.code);
  if (!code) return res.status(400).render('home', {
    error: 'Enter the complete verification code or link shown on your certificate.',
  });
  return res.redirect(303, `/verify/${code}`);
});

// Открытой поисковой выдаче доступна только главная страница.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(temporaryHost
    ? 'User-agent: *\nDisallow: /\n'
    : 'User-agent: *\nDisallow: /verify/\nDisallow: /check\n');
});

// Браузеры просят /favicon.ico сами, даже когда в разметке указан svg.
app.get('/favicon.ico', (req, res) => {
  res.type('image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(path.join(config.paths.public, 'assets', 'favicon.svg'));
});

// redirect: false — иначе запрос каталога отвечает 301 и выдаёт, что он существует.
// Наружу всё, кроме действующего сертификата, должно выглядеть одинаковым 404.
const serve = (dir, maxAge) =>
  express.static(path.join(config.paths.public, dir), { maxAge, redirect: false, index: false });

app.use('/assets', serve('assets', '7d'));
app.use('/fonts', serve('fonts', '30d'));
app.use('/panel', serve('panel', 0));
app.use('/verify', serve('verify', 0));

app.use('/verify', verifyRouter);
app.use(`/${config.panelPath}`, panelRouter);

/**
 * Всё, что не является главной страницей или действующим сертификатом,
 * отвечает одинаковой страницей 404.
 */
app.use((req, res) => {
  res.status(404).render('not-found', { title: 'Certificate not found' });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  // Превышение лимита загрузки — это ошибка запроса, а не сбой сервера.
  const status = err.name === 'MulterError' ? 400 : Number(err.status || err.statusCode) || 500;
  if (status >= 500) console.error('Unhandled request error:', err.name, err.code || '');

  // Ошибки формы должны дойти до панели текстом, а не общей страницей.
  if (req.path.startsWith(`/${config.panelPath}/api/`)) {
    const message = status >= 500 ? 'Внутренняя ошибка сервера' : err.message;
    return res.status(status).json({ error: message });
  }
  return res.status(status).render('error', { title: 'Server error' });
});

if (admins.count() === 0) {
  console.warn('\n  Администратор не создан. Выполните: npm run admin\n');
}
if (config.env === 'production' && !config.siteUrl.startsWith('https://')) {
  console.warn(
    '\n  SITE_URL без https. Cookie панели помечены secure и по http не сохранятся —\n' +
      '  войти не получится. Поставьте сайт за HTTPS или смените NODE_ENV.\n',
  );
}

// За nginx слушаем только петлю, чтобы порт не торчал наружу мимо прокси.
const host = process.env.HOST || (config.env === 'production' ? '127.0.0.1' : '0.0.0.0');

const server = app.listen(config.port, host, () => {
  console.log(`  Сайт:   ${config.siteUrl}`);
  console.log(`  Слушаю: ${host}:${config.port}`);
  // Полный адрес панели в журнал не пишем — он есть в .env (PANEL_PATH).
  console.log(
    config.env === 'production'
      ? `  Панель: ${config.siteUrl}/${config.panelPath.slice(0, 4)}… (полный путь — в .env)\n`
      : '  Панель: путь указан в .env\n',
  );


});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${signal}: завершаю работу`);

  // Если соединения зависли, не держим сервис вечно.
  const force = setTimeout(() => process.exit(1), 10_000).unref();

  await new Promise((resolve) => server.close(resolve));
  db.close();
  clearTimeout(force);
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));

process.on('unhandledRejection', (err) => console.error('Необработанный отказ промиса:', err));
