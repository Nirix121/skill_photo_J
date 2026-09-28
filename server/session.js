import session from 'express-session';
import { SqliteStore } from './session-store.js';
import { config } from './config.js';

export const sessionMiddleware = session({
  name: 'pj.sid',
  store: new SqliteStore(),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    maxAge: config.sessionMaxAgeMs,
  },
});
