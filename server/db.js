import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.paths.db);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS certificates (
    id             INTEGER PRIMARY KEY,
    cert_number    TEXT NOT NULL,
    folder         TEXT NOT NULL CHECK (folder IN ('ldb', 'edb')),
    code           TEXT NOT NULL,
    slug           TEXT NOT NULL UNIQUE,

    issue_date     TEXT NOT NULL DEFAULT '',
    item_number    TEXT NOT NULL DEFAULT '',
    description    TEXT NOT NULL DEFAULT '',
    size           TEXT NOT NULL DEFAULT '',
    metal          TEXT NOT NULL DEFAULT '',
    fineness       TEXT NOT NULL DEFAULT '',
    weight         TEXT NOT NULL DEFAULT '',
    gemstones      TEXT NOT NULL DEFAULT '[]',

    photo_file     TEXT,
    extra_doc_file TEXT,
    extra_doc_name TEXT,
    pdf_file       TEXT,

    revision       INTEGER NOT NULL DEFAULT 0,
    pdf_revision   INTEGER NOT NULL DEFAULT -1,

    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cert_number  ON certificates (cert_number);
  CREATE INDEX IF NOT EXISTS idx_cert_created ON certificates (created_at DESC);

  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );
`);

// Existing installations need the new revocation field without losing accounts.
if (!db.prepare('PRAGMA table_info(admins)').all().some((column) => column.name === 'session_version')) {
  db.exec('ALTER TABLE admins ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare('PRAGMA table_info(certificates)').all().some((column) => column.name === 'revision')) {
  db.exec('ALTER TABLE certificates ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare('PRAGMA table_info(certificates)').all().some((column) => column.name === 'pdf_revision')) {
  // Regenerate pre-migration PDFs once; their content may already be stale.
  db.exec('ALTER TABLE certificates ADD COLUMN pdf_revision INTEGER NOT NULL DEFAULT -1');
}

const parseGemstones = (raw) => {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const hydrate = (row) => (row ? { ...row, gemstones: parseGemstones(row.gemstones) } : null);

export const certificates = {
  byId(id) {
    return hydrate(db.prepare('SELECT * FROM certificates WHERE id = ?').get(id));
  },

  bySlug(slug) {
    return hydrate(db.prepare('SELECT * FROM certificates WHERE slug = ?').get(slug));
  },

  slugExists(slug) {
    return Boolean(db.prepare('SELECT 1 FROM certificates WHERE slug = ?').get(slug));
  },

  /** Поиск по номеру сертификата, номеру изделия, описанию и адресу. */
  list({ search = '', folder = '', limit = 100, offset = 0 } = {}) {
    const where = [];
    const params = [];

    if (search.trim()) {
      const like = `%${search.trim()}%`;
      where.push(
        '(cert_number LIKE ? OR item_number LIKE ? OR description LIKE ? OR slug LIKE ? OR metal LIKE ?)',
      );
      params.push(like, like, like, like, like);
    }
    if (folder) {
      where.push('folder = ?');
      params.push(folder);
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT * FROM certificates ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM certificates ${clause}`)
      .get(...params);

    return { rows: rows.map(hydrate), total };
  },

  create(data) {
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO certificates
           (cert_number, folder, code, slug, issue_date, item_number, description, size,
            metal, fineness, weight, gemstones, photo_file, extra_doc_file, extra_doc_name,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        data.cert_number,
        data.folder,
        data.code,
        data.slug,
        data.issue_date,
        data.item_number,
        data.description,
        data.size,
        data.metal,
        data.fineness,
        data.weight,
        JSON.stringify(data.gemstones ?? []),
        data.photo_file ?? null,
        data.extra_doc_file ?? null,
        data.extra_doc_name ?? null,
        now,
        now,
      );
    return this.byId(info.lastInsertRowid);
  },

  update(id, data) {
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(data)) {
      fields.push(`${key} = ?`);
      params.push(key === 'gemstones' ? JSON.stringify(value ?? []) : value);
    }
    fields.push('revision = revision + 1');
    fields.push('updated_at = ?');
    params.push(new Date().toISOString(), id);
    db.prepare(`UPDATE certificates SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.byId(id);
  },

  /** Publish the PDF only for the certificate revision that was rendered. */
  setPdfFile(id, file, revision) {
    return db.prepare(
      'UPDATE certificates SET pdf_file = ?, pdf_revision = ? WHERE id = ? AND revision = ?',
    ).run(file, revision, id, revision).changes === 1;
  },

  remove(id) {
    db.prepare('DELETE FROM certificates WHERE id = ?').run(id);
  },

  stats() {
    return db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(folder = 'ldb') AS ldb,
                SUM(folder = 'edb') AS edb
         FROM certificates`,
      )
      .get();
  },
};

export const admins = {
  byId(id) {
    return db.prepare('SELECT * FROM admins WHERE id = ?').get(id) ?? null;
  },

  byUsername(username) {
    return db.prepare('SELECT * FROM admins WHERE username = ?').get(username) ?? null;
  },

  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
  },

  upsert(username, passwordHash) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO admins (username, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (username)
       DO UPDATE SET password_hash = excluded.password_hash,
                     session_version = admins.session_version + 1,
                     updated_at = excluded.updated_at`,
    ).run(username, passwordHash, now, now);
  },
};
