import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const moduleAt = (root, name) => import(pathToFileURL(path.join(root, 'server', name)).href);

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function legacyDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec([
    'CREATE TABLE admins (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
    'CREATE TABLE certificates (',
    'id INTEGER PRIMARY KEY, cert_number TEXT NOT NULL, folder TEXT NOT NULL, code TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,',
    "issue_date TEXT NOT NULL DEFAULT '', item_number TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',",
    "size TEXT NOT NULL DEFAULT '', metal TEXT NOT NULL DEFAULT '', fineness TEXT NOT NULL DEFAULT '',",
    "weight TEXT NOT NULL DEFAULT '', gemstones TEXT NOT NULL DEFAULT '[]',",
    'photo_file TEXT, extra_doc_file TEXT, extra_doc_name TEXT, pdf_file TEXT,',
    'created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
  ].join(' '));
  db.prepare("INSERT INTO certificates (cert_number, folder, code, slug, issue_date, description, created_at, updated_at) VALUES ('OLD', 'ldb', '1', 'old1', '2026-01-01', 'old', '2026-01-01', '2026-01-01')").run();
  db.close();
}

async function waitForHealth(base, child, output) {
  for (let i = 0; i < 150; i += 1) {
    if (child.exitCode !== null) throw new Error('Server exited: ' + output());
    try {
      const response = await fetch(base + '/health');
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('Server did not start: ' + output());
}

function uploadForm(photo, document) {
  const form = new FormData();
  form.set('cert_number', 'TEST1');
  form.set('folder', 'ldb');
  form.set('issue_date', '2026-09-26');
  form.set('description', 'Test ring');
  if (photo) form.set('photo', new Blob([photo.bytes], { type: photo.type }), photo.name);
  if (document) form.set('document', new Blob([document.bytes], { type: document.type }), document.name);
  return form;
}

test('security boundaries survive migration and keep normal certificate workflow', { timeout: 180_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'certificate-security-'));
  fs.cpSync(path.join(source, 'server'), path.join(root, 'server'), { recursive: true });
  fs.cpSync(path.join(source, 'public'), path.join(root, 'public'), { recursive: true });
  fs.copyFileSync(path.join(source, 'package.json'), path.join(root, 'package.json'));
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(root, 'data'));
  legacyDatabase(path.join(root, 'data', 'app.db'));

  const port = await freePort();
  const env = {
    ...process.env,
    PANEL_PATH: 'test-panel-secret',
    SESSION_SECRET: 'a-test-only-secret-with-more-than-32-characters',
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(port),
    SITE_URL: 'http://127.0.0.1:' + port,
    MAX_DOC_MB: '1',
  };
  Object.assign(process.env, env);

  const { db, admins, certificates } = await moduleAt(root, 'db.js');
  const { hashPassword, authenticate } = await moduleAt(root, 'auth.js');
  const { photoFormat, isPdf, storedUploadType } = await moduleAt(root, 'services/upload-types.js');
  const { createRenderGate, renderCertificatePdf } = await moduleAt(root, 'services/pdf.js');
  const { createPdfEnsurer, dropPdf } = await moduleAt(root, 'services/render.js');
  const { filePath } = await moduleAt(root, 'services/storage.js');
  let child;
  let output = '';
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), sleep(10_000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await t.test('old database gains durable versions without losing rows', () => {
    const adminColumns = db.prepare('PRAGMA table_info(admins)').all().map((row) => row.name);
    const certColumns = db.prepare('PRAGMA table_info(certificates)').all().map((row) => row.name);
    assert.ok(adminColumns.includes('session_version'));
    assert.ok(certColumns.includes('revision'));
    assert.ok(certColumns.includes('pdf_revision'));
    assert.equal(certificates.bySlug('old1').pdf_revision, -1);
  });

  await t.test('upload bytes and stored legacy files are classified safely', async () => {
    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer();
    assert.equal(photoFormat(png).mime, 'image/png');
    assert.equal(photoFormat(Buffer.from('<script>alert(1)</script>')), null);
    assert.ok(isPdf(Buffer.from('%PDF-1.4\n'), Buffer.from('body\n%%EOF')));
    const legacy = path.join(root, 'storage', 'legacy.html');
    fs.writeFileSync(legacy, '<script>alert(1)</script>');
    assert.equal(storedUploadType(legacy, 'photo'), null);
    assert.equal(storedUploadType(legacy, 'document'), null);
  });

  admins.upsert('operator', hashPassword('old-password-1234'));
  admins.upsert('second', hashPassword('other-password-1234'));
  await t.test('known and unknown login paths each run one scrypt', () => {
    const original = crypto.scryptSync;
    let calls = 0;
    crypto.scryptSync = (...args) => { calls += 1; return original(...args); };
    try {
      authenticate('operator', 'incorrect');
      assert.equal(calls, 1);
      calls = 0;
      authenticate('unknown', 'incorrect');
      assert.equal(calls, 1);
    } finally {
      crypto.scryptSync = original;
    }
  });

  await t.test('render queue rejects excess work and recovers', async () => {
    const gate = createRenderGate(1, 2, 1000);
    await gate.acquire();
    const second = gate.acquire();
    const third = gate.acquire();
    assert.throws(() => gate.acquire(), (err) => err.status === 503);
    gate.release();
    await second;
    gate.release();
    await third;
    gate.release();
    await gate.acquire();
    gate.release();
  });

  child = spawn(process.execPath, ['server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (bytes) => { output += bytes.toString(); });
  child.stderr.on('data', (bytes) => { output += bytes.toString(); });
  const base = 'http://127.0.0.1:' + port;
  await waitForHealth(base, child, () => output);
  await t.test('public home accepts codes without exposing a search by certificate number', async () => {
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Verify your certificate/);
    const invalid = await fetch(base + '/check', {
      method: 'POST',
      body: new URLSearchParams({ code: 'TEST1' }),
    });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /complete verification code/);
  });
  async function login(username, password) {
    const response = await fetch(base + '/test-panel-secret/login', {
      method: 'POST',
      body: new URLSearchParams({ username, password }),
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    return response.headers.get('set-cookie').split(';')[0];
  }
  const api = base + '/test-panel-secret/api/certificates';
  const oldCookie = await login('operator', 'old-password-1234');
  const otherCookie = await login('second', 'other-password-1234');

  await t.test('password rotation revokes old sessions but preserves other users', async () => {
    assert.equal((await fetch(api, { headers: { Cookie: oldCookie } })).status, 200);
    admins.upsert('operator', hashPassword('new-password-1234'));
    assert.equal((await fetch(api, { headers: { Cookie: oldCookie } })).status, 401);
    const oldPage = await fetch(base + '/test-panel-secret/', { headers: { Cookie: oldCookie } });
    assert.match(await oldPage.text(), /Вход/);
    assert.equal((await fetch(api, { headers: { Cookie: otherCookie } })).status, 200);
  });
  const cookie = await login('operator', 'new-password-1234');

  await t.test('cross-origin panel writes are rejected', async () => {
    const form = uploadForm(null, null);
    const response = await fetch(api, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: 'https://other.example' },
      body: form,
    });
    assert.equal(response.status, 403);
    assert.equal(certificates.list({}).total, 1);
  });

  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer();
  await t.test('active content is rejected while real image and PDF remain available', async () => {
    const html = Buffer.from('<!doctype html><script>globalThis.pwned=1</script>');
    const script = Buffer.from('globalThis.pwned=1');
    const badPhoto = await fetch(api, {
      method: 'POST', headers: { Cookie: cookie },
      body: uploadForm({ bytes: script, type: 'image/jpeg', name: 'photo.js' }, null),
    });
    assert.equal(badPhoto.status, 415);
    const corruptPng = await fetch(api, {
      method: 'POST', headers: { Cookie: cookie },
      body: uploadForm({ bytes: png.subarray(0, 24), type: 'image/png', name: 'truncated.png' }, null),
    });
    assert.equal(corruptPng.status, 415);
    const badDoc = await fetch(api, {
      method: 'POST', headers: { Cookie: cookie },
      body: uploadForm({ bytes: png, type: 'image/png', name: 'photo.png' }, { bytes: html, type: 'application/pdf', name: 'document.html' }),
    });
    assert.equal(badDoc.status, 415);
    assert.equal(certificates.list({}).total, 1); // Only the pre-migration fixture remains.

    const good = await fetch(api, {
      method: 'POST', headers: { Cookie: cookie },
      body: uploadForm({ bytes: png, type: 'image/png', name: 'photo.html' }, null),
    });
    assert.equal(good.status, 201);
    const issued = await good.json();
    const check = await fetch(base + '/check', {
      method: 'POST',
      body: new URLSearchParams({ code: 'https://new-domain.example/verify/' + issued.slug }),
      redirect: 'manual',
    });
    assert.equal(check.status, 303);
    assert.equal(check.headers.get('location'), '/verify/' + issued.slug);
    if (!issued.pdf_ready) {
      try {
        await renderCertificatePdf(issued.slug);
      } catch (err) {
        throw new Error('PDF renderer failed: ' + err.stack + '\nServer output: ' + output);
      }
    }
    assert.match(issued.photo_file, /^photo-[0-9a-f]{24}\.png$/);
    const media = await fetch(base + '/verify/' + issued.slug + '/media/' + issued.photo_file);
    assert.equal(media.status, 200);
    assert.match(media.headers.get('content-type'), /^image\/png/);
    const generated = await fetch(base + '/verify/' + issued.slug + '/certificate.pdf');
    assert.equal(generated.status, 200, output);
    const pdf = Buffer.from(await generated.arrayBuffer());
    assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')));

    const editForm = uploadForm(null, { bytes: pdf, type: 'application/pdf', name: 'report.html' });
    editForm.set('extra_doc_name', 'Warranty');
    const edit = await fetch(api + '/' + issued.id, { method: 'POST', headers: { Cookie: cookie }, body: editForm });
    assert.equal(edit.status, 200);
    const updated = await edit.json();
    assert.match(updated.extra_doc_file, /^document-[0-9a-f]{24}\.pdf$/);
    const document = await fetch(base + '/verify/' + issued.slug + '/document.pdf');
    assert.equal(document.status, 200);
    assert.match(document.headers.get('content-type'), /^application\/pdf/);
    const alias = await fetch(base + '/verify/' + issued.slug + '/media/' + updated.extra_doc_file);
    assert.equal(alias.status, 200);
    assert.match(alias.headers.get('content-type'), /^application\/pdf/);
    assert.match(alias.headers.get('content-disposition'), /^attachment/);

    const badEdit = await fetch(api + '/' + issued.id, {
      method: 'POST', headers: { Cookie: cookie },
      body: uploadForm({ bytes: png, type: 'image/png', name: 'photo.png' }, { bytes: html, type: 'application/pdf', name: 'document.html' }),
    });
    assert.equal(badEdit.status, 415);
    assert.equal(certificates.byId(issued.id).extra_doc_file, updated.extra_doc_file);

    const oversizedPdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'), Buffer.alloc(1_100_000, 0x20), Buffer.from('\n%%EOF'),
    ]);
    const oversizedEdit = await fetch(api + '/' + issued.id, {
      method: 'POST', headers: { Cookie: cookie },
      body: uploadForm(
        { bytes: png, type: 'image/png', name: 'replacement.png' },
        { bytes: oversizedPdf, type: 'application/pdf', name: 'oversized.pdf' },
      ),
    });
    assert.equal(oversizedEdit.status, 413);
    assert.equal(certificates.byId(issued.id).photo_file, updated.photo_file);
    assert.equal((await fetch(base + '/verify/' + issued.slug + '/media/' + updated.photo_file)).status, 200);

    const certDir = path.dirname(filePath(updated.folder, updated.slug, updated.extra_doc_file));
    fs.writeFileSync(path.join(certDir, 'legacy.html'), html);
    fs.writeFileSync(path.join(certDir, 'legacy.js'), script);
    db.prepare('UPDATE certificates SET extra_doc_file = ?, photo_file = ? WHERE id = ?').run('legacy.html', 'legacy.js', issued.id);
    assert.equal((await fetch(base + '/verify/' + issued.slug + '/document.pdf')).status, 404);
    assert.equal((await fetch(base + '/verify/' + issued.slug + '/media/legacy.html')).status, 404);
    assert.equal((await fetch(base + '/verify/' + issued.slug + '/media/legacy.js')).status, 404);
    db.prepare('UPDATE certificates SET extra_doc_file = ?, photo_file = ? WHERE id = ?').run(updated.extra_doc_file, updated.photo_file, issued.id);
    fs.rmSync(path.join(certDir, 'legacy.html'));
    fs.rmSync(path.join(certDir, 'legacy.js'));

    const downloads = await Promise.all(Array.from({ length: 8 }, () => fetch(base + '/verify/' + issued.slug + '/certificate.pdf')));
    const hashes = [];
    for (const response of downloads) {
      assert.equal(response.status, 200);
      hashes.push(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'));
    }
    assert.equal(new Set(hashes).size, 1, 'concurrent downloads must receive the same PDF');

    const canary = 'log-canary-sensitive';
    await fetch(base + '/verify/' + canary);
    await fetch(base + '/test-panel-secret/login?secret=' + canary);
    await fetch(base + '/internal/certificate/' + canary + '?token=' + canary);
    await sleep(100);
    assert.ok(!output.includes(canary), 'request logs must omit raw path and query');
    assert.ok(!output.includes('test-panel-secret'), 'logs must omit panel path');

    const live = certificates.byId(issued.id);
    db.prepare('UPDATE certificates SET pdf_revision = -1 WHERE id = ?').run(live.id);
    dropPdf(live);
    let started;
    let release;
    const entered = new Promise((resolve) => { started = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    let renders = 0;
    const ensure = createPdfEnsurer(async () => {
      renders += 1;
      if (renders === 1) {
        started();
        await held;
        return Buffer.from('%PDF-1.4\nOLD\n%%EOF');
      }
      return Buffer.from('%PDF-1.4\nNEW\n%%EOF');
    });
    const first = ensure(live);
    const second = ensure(live);
    await entered;
    const corrected = certificates.update(live.id, { description: 'Corrected ring' });
    dropPdf(corrected);
    release();
    const [firstPath, secondPath] = await Promise.all([first, second]);
    assert.equal(firstPath, secondPath);
    assert.equal(renders, 2, 'old generation must be discarded and current one rendered once');
    assert.match(fs.readFileSync(firstPath, 'utf8'), /NEW/);
    assert.equal(certificates.byId(live.id).pdf_revision, certificates.byId(live.id).revision);
  });
});
