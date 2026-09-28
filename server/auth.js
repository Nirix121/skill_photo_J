import crypto from 'node:crypto';
import { admins } from './db.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;

  const expected = Buffer.from(key, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return crypto.timingSafeEqual(expected, actual);
}

// Created once so both existing and unknown usernames perform one scrypt per attempt.
const DUMMY_HASH = hashPassword(crypto.randomBytes(32).toString('hex'));

export function authenticate(username, password) {
  const admin = admins.byUsername(username);
  // Считаем хеш даже для несуществующего пользователя, чтобы время ответа не выдавало,
  // существует логин или нет.
  const stored = admin?.password_hash ?? DUMMY_HASH;
  const ok = verifyPassword(password, stored);
  return ok && admin ? admin : null;
}

export function requireAuth(req, res, next) {
  if (hasActiveAdminSession(req)) return next();

  // Запросам API нужен явный 401: панель покажет «войдите заново», а не разберёт
  // страницу входа как ответ. Переходы по ссылкам отправляем на форму входа.
  if (req.baseUrl.endsWith('/api') || req.xhr) {
    return res.status(401).json({ error: 'Сессия истекла — войдите заново' });
  }
  return res.redirect(req.app.locals.panelUrl);
}

export function hasActiveAdminSession(req) {
  const adminId = req.session?.adminId;
  if (!Number.isInteger(adminId)) return false;
  const admin = admins.byId(adminId);
  return Boolean(admin && req.session.adminVersion === admin.session_version);
}
