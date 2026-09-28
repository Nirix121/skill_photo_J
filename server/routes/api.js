import express from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import sharp from 'sharp';
import { config } from '../config.js';
import { certificates } from '../db.js';
import { requireAuth } from '../auth.js';
import { HttpError, asyncHandler } from '../util.js';
import { parseForm } from '../services/certificate.js';
import { allocateSlug } from '../services/slug.js';
import { dropPdf, ensurePdf, verifyUrl } from '../services/render.js';
import { photoFormat, isPdf } from '../services/upload-types.js';
import {
  ensureCertDir,
  fileExists,
  removeCertDir,
  removeFile,
  saveFile,
} from '../services/storage.js';

export const apiRouter = express.Router();

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DOC_TYPES = ['application/pdf'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.max(config.uploads.maxPhotoBytes, config.uploads.maxDocBytes),
    files: 2,
  },
  fileFilter(req, file, cb) {
    const allowed = file.fieldname === 'photo' ? PHOTO_TYPES : DOC_TYPES;
    if (!allowed.includes(file.mimetype)) {
      return cb(new HttpError(415, `Недопустимый тип файла: ${file.mimetype}`));
    }
    return cb(null, true);
  },
}).fields([
  { name: 'photo', maxCount: 1 },
  { name: 'document', maxCount: 1 },
]);

apiRouter.use(requireAuth);

/** Запись для панели: к полям из базы добавляются адрес и признак вложения. */
const serialize = (cert) => ({
  ...cert,
  path: `/verify/${cert.slug}`,
  url: verifyUrl(cert.slug),
  has_extra_doc: fileExists(cert.folder, cert.slug, cert.extra_doc_file),
});

apiRouter.get('/certificates', (req, res) => {
  const { rows, total } = certificates.list({
    search: String(req.query.search || ''),
    folder: config.folders.includes(req.query.folder) ? req.query.folder : '',
    limit: Math.min(Number(req.query.limit) || 100, 200),
    offset: Number(req.query.offset) || 0,
  });
  res.json({ total, stats: certificates.stats(), items: rows.map(serialize) });
});

apiRouter.get('/certificates/:id', (req, res, next) => {
  const cert = certificates.byId(Number(req.params.id));
  if (!cert) return next(new HttpError(404, 'Сертификат не найден'));
  return res.json(serialize(cert));
});

apiRouter.post('/certificates', upload, asyncHandler(async (req, res) => {
  const { data, errors } = parseForm(req.body);
  if (errors.length) throw new HttpError(400, errors.join('. '));

  // Адрес выдаётся один раз: номер и папка входят в него и дальше не меняются.
  const { code, slug } = allocateSlug(data.cert_number, data.folder);
  ensureCertDir(data.folder, slug);

  const files = await attachFiles(data.folder, slug, req.files, req.body);
  let cert;
  try {
    cert = certificates.create({ ...data, ...files, code, slug });
  } catch (err) {
    removeStagedFiles(data.folder, slug, files);
    throw err;
  }

  // Печатаем сразу, чтобы клиент по ссылке получил файл мгновенно. Сбой печати
  // не отменяет выставление: сертификат уже существует, PDF соберётся при скачивании.
  let pdfReady = true;
  try {
    await ensurePdf(cert);
  } catch (err) {
    pdfReady = false;
    console.error('Не удалось напечатать PDF:', err.name, err.code || '');
  }

  res.status(201).json({ ...serialize(certificates.byId(cert.id)), pdf_ready: pdfReady });
}));

apiRouter.post('/certificates/:id', upload, asyncHandler(async (req, res) => {
    const current = certificates.byId(Number(req.params.id));
    if (!current) throw new HttpError(404, 'Сертификат не найден');

    const { data, errors } = parseForm({
      ...req.body,
      // Номер и папка зашиты в адрес — правка их не затрагивает.
      cert_number: current.cert_number,
      folder: current.folder,
    });
    if (errors.length) throw new HttpError(400, errors.join('. '));
    delete data.cert_number;
    delete data.folder;

    const files = await attachFiles(current.folder, current.slug, req.files, req.body, current);
    let cert;
    try {
      cert = certificates.update(current.id, { ...data, ...files });
    } catch (err) {
      removeStagedFiles(current.folder, current.slug, files);
      throw err;
    }
    removeReplacedFiles(current, files);
    dropPdf(cert);
    res.json(serialize(cert));
}));

apiRouter.delete('/certificates/:id', (req, res, next) => {
  try {
    const cert = certificates.byId(Number(req.params.id));
    if (!cert) throw new HttpError(404, 'Сертификат не найден');
    // Папка удаляется вместе с записью: адрес освобождается и может быть выдан заново.
    removeCertDir(cert.folder, cert.slug);
    certificates.remove(cert.id);
    res.json({ ok: true, slug: cert.slug });
  } catch (err) {
    next(err);
  }
});

/** Validate everything before writing, then stage new files without deleting live ones. */
async function attachFiles(folder, slug, files, body, current = null) {
  const out = {};
  const photo = files?.photo?.[0];
  const doc = files?.document?.[0];

  // Validate both files before replacing either existing attachment.
  const format = photo ? photoFormat(photo.buffer) : null;
  if (photo && (!format || format.mime !== photo.mimetype)) {
    throw new HttpError(415, 'Фото должно быть файлом JPEG, PNG или WebP');
  }
  if (doc && !isPdf(doc.buffer.subarray(0, 12), doc.buffer.subarray(-1024))) {
    throw new HttpError(415, 'Документ должен быть файлом PDF');
  }
  if (photo && photo.size > config.uploads.maxPhotoBytes) {
    throw new HttpError(413, 'Фото больше допустимого размера');
  }
  if (doc && doc.size > config.uploads.maxDocBytes) {
    throw new HttpError(413, 'Документ больше допустимого размера');
  }

  if (photo) {
    try {
      await sharp(photo.buffer, { limitInputPixels: 16_000_000, failOn: 'error', pages: 1 })
        .rotate().resize(8, 8, { fit: 'inside' }).toBuffer();
    } catch {
      throw new HttpError(415, 'Фото повреждено или слишком велико');
    }
  }

  try {
    if (photo) {
      out.photo_file = saveFile(
        folder,
        slug,
        `photo-${crypto.randomBytes(12).toString('hex')}.${format.extension}`,
        photo.buffer,
      );
    }

    if (doc) {
      out.extra_doc_file = saveFile(
        folder,
        slug,
        `document-${crypto.randomBytes(12).toString('hex')}.pdf`,
        doc.buffer,
      );
      out.extra_doc_name = String(body.extra_doc_name || doc.originalname).slice(0, 160);
    } else if (current?.extra_doc_file && body.remove_document === '1') {
      out.extra_doc_file = null;
      out.extra_doc_name = null;
    } else if (current?.extra_doc_file && body.extra_doc_name !== undefined) {
      out.extra_doc_name = String(body.extra_doc_name || '').slice(0, 160);
    }
  } catch (err) {
    removeStagedFiles(folder, slug, out);
    throw err;
  }

  return out;
}

function removeStagedFiles(folder, slug, fields) {
  for (const file of [fields.photo_file, fields.extra_doc_file]) {
    if (file) removeFile(folder, slug, file);
  }
}

function removeReplacedFiles(current, fields) {
  if (fields.photo_file && current.photo_file) {
    removeFile(current.folder, current.slug, current.photo_file);
  }
  if ('extra_doc_file' in fields && current.extra_doc_file) {
    removeFile(current.folder, current.slug, current.extra_doc_file);
  }
}

apiRouter.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status === 500) console.error('API error:', err.name, err.code || '');
  return res.status(status).json({
    error: status === 500 ? 'Внутренняя ошибка сервера' : err.message || 'Ошибка запроса',
  });
});
