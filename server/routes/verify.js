import express from 'express';
import rateLimit from 'express-rate-limit';
import { certificates } from '../db.js';
import { certificateViewModel, ensurePdf } from '../services/render.js';
import { filePath, fileExists } from '../services/storage.js';
import { storedUploadType } from '../services/upload-types.js';
import { asyncHandler } from '../util.js';

export const verifyRouter = express.Router();

// A certificate link is a bearer link; keep HTML and attachments out of search indexes.
verifyRouter.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});

const limit = (max, message) =>
  rateLimit({
    windowMs: 15 * 60_000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message,
    handler: (req, res, next, options) =>
      res.status(options.statusCode).render('error', { title: options.message }),
  });

// Создание PDF требует ресурсов, поэтому оно ограничено строже показа страницы.
const pageLimiter = limit(300, 'Too many requests. Please try again in a few minutes.');
const pdfLimiter = limit(60, 'Too many PDF requests. Please try again in a few minutes.');

/** Сертификат существует, пока цела его папка: удалили — адрес больше не открывается. */
function findLive(slug) {
  const cert = certificates.bySlug(String(slug || ''));
  if (!cert) return null;
  if (cert.photo_file && (!fileExists(cert.folder, cert.slug, cert.photo_file)
    || !storedUploadType(filePath(cert.folder, cert.slug, cert.photo_file), 'photo'))) {
    return { ...cert, photo_file: null };
  }
  return cert;
}

const notFound = (res) =>
  res.status(404).render('not-found', { title: 'Certificate not found' });

verifyRouter.get('/:slug', pageLimiter, (req, res) => {
  const cert = findLive(req.params.slug);
  if (!cert) return notFound(res);

  // Данные сертификата могут быть исправлены — браузер обязан сверяться с сервером.
  res.setHeader('Cache-Control', 'no-cache');
  res.render('verify', {
    title: `Certificate No. ${cert.cert_number}`,
    ...certificateViewModel(cert),
    hasExtraDoc: cert.extra_doc_file && fileExists(cert.folder, cert.slug, cert.extra_doc_file)
      && storedUploadType(filePath(cert.folder, cert.slug, cert.extra_doc_file), 'document') === 'application/pdf',
  });
});

verifyRouter.get(
  '/:slug/certificate.pdf',
  pdfLimiter,
  asyncHandler(async (req, res) => {
    const cert = findLive(req.params.slug);
    if (!cert) return notFound(res);

    const pdf = await ensurePdf(cert);
    res.type('application/pdf');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="certificate-${cert.cert_number}.pdf"`,
    );
    return res.sendFile(pdf);
  }),
);

verifyRouter.get('/:slug/document.pdf', pageLimiter, (req, res) => {
  const cert = findLive(req.params.slug);
  if (!cert || !fileExists(cert.folder, cert.slug, cert.extra_doc_file)) {
    return res.status(404).render('not-found', { title: 'Document not found' });
  }
  if (storedUploadType(filePath(cert.folder, cert.slug, cert.extra_doc_file), 'document') !== 'application/pdf') {
    return res.status(404).render('not-found', { title: 'Document not found' });
  }
  res.type('application/pdf');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(cert.extra_doc_name || 'document.pdf')}`,
  );
  return res.sendFile(filePath(cert.folder, cert.slug, cert.extra_doc_file));
});

verifyRouter.get('/:slug/media/:file', pageLimiter, (req, res) => {
  const cert = findLive(req.params.slug);
  const file = req.params.file;
  // Отдаём только те файлы, которые числятся за этим сертификатом.
  if (!cert || ![cert.photo_file, cert.extra_doc_file].includes(file)) {
    return res.sendStatus(404);
  }
  if (!fileExists(cert.folder, cert.slug, file)) return res.sendStatus(404);
  const kind = file === cert.photo_file ? 'photo' : 'document';
  const mime = storedUploadType(filePath(cert.folder, cert.slug, file), kind);
  if (!mime) return res.sendStatus(404);
  res.type(mime);
  if (kind === 'document') res.setHeader('Content-Disposition', 'attachment; filename="document.pdf"');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  return res.sendFile(filePath(cert.folder, cert.slug, file));
});
