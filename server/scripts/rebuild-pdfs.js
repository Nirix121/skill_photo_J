import fs from 'node:fs';
import { config } from '../config.js';
import { db, certificates } from '../db.js';
import { filePath } from '../services/storage.js';

// Run after SITE_URL or the certificate template changes. The live server must be running.
const health = await fetch(`http://127.0.0.1:${config.port}/health`);
if (!health.ok) throw new Error(`Site health check failed: HTTP ${health.status}`);

const ids = db.prepare('SELECT id FROM certificates ORDER BY id').all().map((row) => row.id);
let rebuilt = 0;
for (const id of ids) {
  const cert = certificates.byId(id);
  // Keep the old PDF available until the server atomically replaces it.
  db.prepare('UPDATE certificates SET pdf_revision = -1 WHERE id = ?').run(id);
  const response = await fetch(`http://127.0.0.1:${config.port}/verify/${cert.slug}/certificate.pdf`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const target = filePath(cert.folder, cert.slug, 'certificate.pdf');
  if (response.status !== 200 || bytes.subarray(0, 5).toString() !== '%PDF-' || !fs.existsSync(target)) {
    throw new Error(`Could not rebuild ${cert.cert_number}: HTTP ${response.status}`);
  }
  const saved = certificates.byId(id);
  if (saved.pdf_revision !== saved.revision) throw new Error(`PDF revision mismatch: ${cert.cert_number}`);
  rebuilt += 1;
  console.log(`${rebuilt}/${ids.length} ${cert.cert_number}`);
}
console.log(`Rebuilt ${rebuilt} PDFs`);
