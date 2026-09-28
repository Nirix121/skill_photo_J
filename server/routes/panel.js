import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { authenticate, hasActiveAdminSession } from '../auth.js';
import { admins, certificates } from '../db.js';
import { requireAuth } from '../auth.js';
import { apiRouter } from './api.js';

export const panelRouter = express.Router();

// Browsers send Origin on writes. Reject requests from another site even if a
// session cookie becomes available through a future domain configuration.
const panelOrigin = new URL(config.siteUrl).origin;
panelRouter.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('Origin');
    if (origin && origin !== panelOrigin) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Недопустимый источник запроса' });
      return res.sendStatus(403);
    }
  }
  return next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток входа. Повторите через 15 минут.' },
});

const panelUrl = () => `/${config.panelPath}`;

panelRouter.get('/', (req, res) => {
  if (!hasActiveAdminSession(req)) {
    return res.render('login', {
      title: 'Вход',
      panelUrl: panelUrl(),
      error: null,
      noAdmin: admins.count() === 0,
    });
  }
  res.render('panel', {
    title: 'Панель выставления',
    panelUrl: panelUrl(),
    username: req.session.username,
    folders: config.folders,
    siteUrl: config.siteUrl,
    codeDigits: config.codeDigits,
    stats: certificates.stats(),
  });
});

panelRouter.post('/login', loginLimiter, express.urlencoded({ extended: false }), (req, res) => {
  const admin = authenticate(String(req.body.username || ''), String(req.body.password || ''));
  if (!admin) {
    return res.status(401).render('login', {
      title: 'Вход',
      panelUrl: panelUrl(),
      error: 'Неверный логин или пароль',
      noAdmin: admins.count() === 0,
    });
  }

  // Новый идентификатор сессии после входа — защита от фиксации сессии.
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('login', {
      title: 'Вход',
      panelUrl: panelUrl(),
      error: 'Не удалось создать сессию',
      noAdmin: false,
    });
    req.session.adminId = admin.id;
    req.session.adminVersion = admin.session_version;
    req.session.username = admin.username;
    res.redirect(panelUrl());
  });
});

panelRouter.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.redirect(panelUrl()));
});

panelRouter.use('/api', apiRouter);
