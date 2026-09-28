import fs from 'node:fs';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { certificates } from '../db.js';
import { ensureCertDir, fileExists, filePath } from './storage.js';
import { renderCertificatePdf } from './pdf.js';
import { HttpError } from '../util.js';

const PDF_FILE = 'certificate.pdf';

/** Подпись под QR-кодом на листе. Берётся из макета PALMIRA. */
const QR_CAPTION = process.env.QR_CAPTION || 'palmirajewels.com';

/**
 * QR в виде инлайнового SVG. Генерация синхронная, поэтому модель представления
 * собирается без await — и шаблон, и Puppeteer получают готовую разметку.
 */
export function qrSvg(text) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const { size, data } = modules;
  let d = '';
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (data[row * size + col]) d += `M${col} ${row}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `width="96" height="96" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${d}" fill="#1a1a1a"/></svg>`
  );
}

export function verifyUrl(slug) {
  return `${config.siteUrl}/verify/${slug}`;
}

/** Данные для шаблонов сертификата и страницы проверки. */
export function certificateViewModel(cert) {
  const url = verifyUrl(cert.slug);
  return {
    cert: { ...cert, gemstones: cert.gemstones ?? [] },
    verifyUrl: url,
    photoUrl: cert.photo_file
      ? `/verify/${cert.slug}/media/${encodeURIComponent(cert.photo_file)}`
      : '/assets/ring.jpg',
    qrSvg: qrSvg(url),
    // Подпись под QR — это подпись бренда из макета, а не адрес этого сервера.
    // Сам QR при этом ведёт на проверку конкретного сертификата.
    qrCaption: QR_CAPTION,
  };
}

/**
 * Путь к PDF сертификата. Файл собирается один раз и пересобирается только
 * после правок — так скачивание не зависит от запуска браузера каждый раз.
 */
export function createPdfEnsurer(render = renderCertificatePdf) {
  const inFlight = new Map();
  return (cert) => {
    if (inFlight.has(cert.id)) return inFlight.get(cert.id);
    const task = buildCurrentPdf(cert.id, render).finally(() => {
      if (inFlight.get(cert.id) === task) inFlight.delete(cert.id);
    });
    inFlight.set(cert.id, task);
    return task;
  };
}

export const ensurePdf = createPdfEnsurer();

async function buildCurrentPdf(id, render) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const cert = certificates.byId(id);
    if (!cert) throw new HttpError(404, 'Сертификат не найден');
    const target = filePath(cert.folder, cert.slug, PDF_FILE);
    if (isFresh(cert)) return target;

    const pdf = await render(cert.slug);
    const latest = certificates.byId(id);
    if (!latest) throw new HttpError(404, 'Сертификат не найден');
    if (latest.revision !== cert.revision || latest.slug !== cert.slug) continue;

    ensureCertDir(cert.folder, cert.slug);
    const temporary = filePath(cert.folder, cert.slug, `certificate-${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, pdf, { flag: 'wx' });
      const beforePublish = certificates.byId(id);
      if (!beforePublish || beforePublish.revision !== cert.revision || beforePublish.slug !== cert.slug) {
        continue;
      }
      fs.renameSync(temporary, target);
      if (!certificates.setPdfFile(id, PDF_FILE, cert.revision)) {
        fs.rmSync(target, { force: true });
        continue;
      }
      return target;
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  throw new HttpError(503, 'Сертификат меняется — повторите скачивание PDF');
}

function isFresh(cert) {
  return cert.pdf_file === PDF_FILE && cert.pdf_revision === cert.revision
    && fileExists(cert.folder, cert.slug, PDF_FILE);
}

/** Сбрасывает собранный PDF — вызывается после правки сертификата. */
export function dropPdf(cert) {
  fs.rmSync(filePath(cert.folder, cert.slug, PDF_FILE), { force: true });
}
