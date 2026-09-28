import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { config } from '../config.js';
import { certificates } from '../db.js';
import { fileExists, filePath } from './storage.js';
import { storedUploadType } from './upload-types.js';
import { HttpError } from '../util.js';

// Coordinates match the 1123 x 794 screen sheet. PDF points are 3/4 CSS pixels.
const W = 1123;
const H = 794;
const S = 0.75;
const C = {
  ink: '#23231f', muted: '#6f6a5c', gold: '#a08e6a',
  paper: '#ffffff', panel: '#fbfaf6', border: '#e7e2d6',
  dots: '#9c9683', grid: '#ddd7c8', gridStrong: '#a79e88',
};
const fallbackDir = path.join(config.root, 'server', 'fonts');
const qrCaption = process.env.QR_CAPTION || 'palmirajewels.com';

export function createRenderGate(maxParallel, maxWaiting, timeoutMs) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error('PDF_CONCURRENCY должен быть положительным целым числом');
  }
  let active = 0;
  const waiting = [];
  function acquire() {
    if (active < maxParallel) { active += 1; return Promise.resolve(); }
    if (waiting.length >= maxWaiting) {
      throw new HttpError(503, 'Сервер занят печатью сертификатов — повторите попытку');
    }
    return new Promise((resolve, reject) => {
      const ticket = { resolve, reject };
      ticket.timer = setTimeout(() => {
        const index = waiting.indexOf(ticket);
        if (index !== -1) waiting.splice(index, 1);
        reject(new HttpError(503, 'Сервер занят печатью других сертификатов — повторите попытку'));
      }, timeoutMs);
      waiting.push(ticket);
    });
  }
  function release() {
    const ticket = waiting.shift();
    if (ticket) { clearTimeout(ticket.timer); ticket.resolve(); }
    else active -= 1;
  }
  return { acquire, release };
}

const { acquire, release } = createRenderGate(Number(process.env.PDF_CONCURRENCY || 2), 16, 45_000);

function setupFonts(doc) {
  doc.registerFont('regular', path.join(fallbackDir, 'NunitoSans-Regular.ttf'));
  doc.registerFont('semibold', path.join(fallbackDir, 'NunitoSans-SemiBold.ttf'));
  doc.registerFont('bold', path.join(fallbackDir, 'NunitoSans-Bold.ttf'));
}

function fontFor(value, weight = 'regular') {
  return weight;
}

function text(doc, value, x, y, width, height, opts = {}) {
  const content = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!content) return;
  let size = opts.size ?? 12.5;
  const min = opts.minSize ?? 8;
  const face = fontFor(content, opts.weight ?? 'regular');
  const spacing = opts.spacing ?? 0;
  doc.font(face);
  while (size > min && doc.fontSize(size).widthOfString(content, { characterSpacing: spacing }) > width) {
    size -= 0.25;
  }
  let shown = content;
  while (shown.length > 1 && doc.fontSize(size).widthOfString(shown, { characterSpacing: spacing }) > width) {
    shown = shown.slice(0, -2) + '…';
  }
  const actual = doc.widthOfString(shown, { characterSpacing: spacing });
  const tx = opts.align === 'right' ? x + width - actual : opts.align === 'center' ? x + (width - actual) / 2 : x;
  const ty = y + (height - size * 1.3) / 2;
  doc.fillColor(opts.color ?? C.ink).text(shown, tx, ty, { lineBreak: false, characterSpacing: spacing });
}

function rect(doc, x, y, width, height, fill, stroke = null, lineWidth = 1) {
  doc.save().lineWidth(lineWidth).rect(x, y, width, height);
  if (fill && stroke) doc.fillAndStroke(fill, stroke);
  else if (fill) doc.fill(fill);
  else if (stroke) doc.stroke(stroke);
  doc.restore();
}

function line(doc, x1, y1, x2, y2, color = C.grid, width = 1, dotted = false) {
  doc.save().strokeColor(color).lineWidth(width);
  if (dotted) doc.dash(1, { space: 2 });
  doc.moveTo(x1, y1).lineTo(x2, y2).stroke().restore();
}

function bar(doc, label, x, y, width) {
  rect(doc, x, y, width, 24, C.gold);
  text(doc, label, x + 5, y, width - 10, 24, {
    weight: 'semibold', size: 10, minSize: 9, spacing: 1.4, align: 'center', color: '#ffffff',
  });
}

function panel(doc, x, y, width, height) {
  rect(doc, x, y, width, height, C.panel, C.border);
}

function rows(doc, items, x, y, width, height) {
  panel(doc, x, y, width, height);
  const rowH = height / items.length;
  for (let i = 0; i < items.length; i += 1) {
    const [label, value] = items[i];
    const top = y + i * rowH;
    const labelW = Math.min(110, width * 0.38);
    text(doc, label, x + 11, top, labelW, rowH, { size: 12.5, minSize: 11, color: '#5f5e55' });
    doc.font(fontFor(String(value ?? ''), 'semibold')).fontSize(12.5);
    const preferred = doc.widthOfString(String(value ?? ''));
    const valueW = Math.min(Math.max(preferred + 4, 34), width - labelW - 34);
    text(doc, value, x + width - 11 - valueW, top, valueW, rowH,
      { size: 12.5, minSize: 8, align: 'right', weight: 'semibold' });
    const lineStart = x + 11 + Math.min(doc.widthOfString(label), labelW) + 7;
    const lineEnd = x + width - 11 - valueW - 6;
    if (lineEnd > lineStart) line(doc, lineStart, top + rowH / 2 + 5, lineEnd, top + rowH / 2 + 5, C.dots, 0.8, true);
  }
}

function gemstones(doc, gems, x, y, width, height) {
  panel(doc, x, y, width, height);
  const innerX = x + 12;
  const innerW = width - 24;
  const gap = 7;
  const weights = [1.2, 0.7, 1, 0.9, 0.9];
  const unit = (innerW - gap * 4) / weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => w * unit);
  const starts = [];
  let cursor = innerX;
  for (let i = 0; i < widths.length; i += 1) { starts.push(cursor); cursor += widths[i] + gap; }
  const heads = ['Cut', 'Qty', 'Quality', 'Color', 'Carat'];
  for (let i = 0; i < heads.length; i += 1) {
    text(doc, heads[i], starts[i], y + 8, widths[i], 18,
      { size: 10.5, minSize: 9, align: i ? 'right' : 'left', color: C.muted, spacing: 0.4 });
    line(doc, starts[i], y + 30, starts[i] + widths[i], y + 30, '#c9c0a8');
  }
  const bodyTop = y + 31;
  const rowH = (height - 36) / gems.length;
  for (let r = 0; r < gems.length; r += 1) {
    const gem = gems[r];
    const values = [gem.cut, gem.qty, gem.quality, gem.color, gem.carat];
    for (let i = 0; i < values.length; i += 1) {
      text(doc, values[i] || '—', starts[i], bodyTop + r * rowH, widths[i], rowH,
        { size: 12.5, minSize: 8, weight: i === 0 ? 'semibold' : 'regular', align: i ? 'right' : 'left' });
      line(doc, starts[i], bodyTop + (r + 1) * rowH, starts[i] + widths[i], bodyTop + (r + 1) * rowH,
        '#cfc8b4', 0.8, true);
    }
  }
}

function drawLeft(doc, cert) {
  const x = 44, y = 130, width = 332, total = 482;
  const gems = Array.isArray(cert.gemstones) ? cert.gemstones : [];
  const barCount = gems.length ? 3 : 2;
  const available = total - barCount * 24 - (barCount - 1) * 16;
  const weights = 7 + (gems.length ? gems.length + 1 : 0);
  const informationH = available * 4 / weights;
  const materialH = available * 3 / weights;
  const gemH = total - (barCount * 24 + (barCount - 1) * 16 + informationH + materialH);
  bar(doc, 'INFORMATION', x, y, width);
  rows(doc, [
    ['Date of issue', cert.issue_date],
    ['Item Number', cert.item_number],
    ['Description', cert.description],
    ['Size', cert.size],
  ], x, y + 24, width, informationH);
  const matY = y + 24 + informationH + 16;
  bar(doc, 'MATERIAL', x, matY, width);
  rows(doc, [
    ['Metal', cert.metal],
    ['Fineness', cert.fineness],
    ['Weight', cert.weight],
  ], x, matY + 24, width, materialH);
  if (gems.length) {
    const gemY = matY + 24 + materialH + 16;
    bar(doc, 'GEMSTONES', x, gemY, width);
    gemstones(doc, gems, x, gemY + 24, width, gemH);
  }
}

async function cleanPhoto(cert) {
  let source = path.join(config.paths.public, 'assets', 'ring.jpg');
  if (cert.photo_file && fileExists(cert.folder, cert.slug, cert.photo_file)) {
    const candidate = filePath(cert.folder, cert.slug, cert.photo_file);
    if (storedUploadType(candidate, 'photo')) source = candidate;
  }
  // Decode once, respect EXIF orientation, strip metadata and bound the pixel count.
  // JPEG output is accepted by PDFKit for JPEG, PNG and WebP inputs.
  return sharp(source, { limitInputPixels: 16_000_000, failOn: 'error', pages: 1 })
    .rotate().resize(300, 300, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

function drawPhoto(doc, photo) {
  bar(doc, 'ITEM PHOTOGRAPH', 397, 170, 330);
  panel(doc, 397, 194, 330, 350);
  doc.image(photo, 412, 209, { width: 300, height: 300 });
}

function rotatedLabel(doc, label, x, y, width, height) {
  if (!label) return;
  doc.save();
  doc.translate(x + width / 2, y + height / 2).rotate(-90);
  text(doc, label, -height / 2 + 2, -width / 2, height - 4, width,
    { size: 8.5, minSize: 6.5, color: C.muted, align: 'center' });
  doc.restore();
}

function scale(doc, x, y, width, height, groups) {
  const totalRows = groups.reduce((sum, group) => sum + group.grades.length, 0);
  const rowH = height / totalRows;
  let top = y;
  for (const group of groups) {
    const groupH = group.grades.length * rowH;
    line(doc, x, top, x + width, top, C.gridStrong, 1.2);
    rotatedLabel(doc, group.name, x, top, 24, groupH);
    line(doc, x + 24, top, x + 24, top + groupH, C.grid);
    line(doc, x + width, top, x + width, top + groupH, C.grid);
    for (let i = 0; i < group.grades.length; i += 1) {
      const gradeY = top + i * rowH;
      if (i) line(doc, x + 24, gradeY, x + width, gradeY, C.grid);
      text(doc, group.grades[i], x + 26, gradeY, width - 28, rowH,
        { size: group.small ? 11 : 12, minSize: 8, align: 'center', color: '#5c5c57' });
    }
    top += groupH;
  }
  line(doc, x, y + height, x + width, y + height, C.grid);
}

function drawScales(doc) {
  panel(doc, 749, 130, 330, 482);
  scale(doc, 763, 144, 143, 454, [
    { name: 'Colourless', grades: ['D', 'E', 'F'] },
    { name: 'Near colourless', grades: ['G', 'H', 'I', 'J'] },
    { name: 'Faint', grades: ['K', 'L', 'M'] },
    { name: 'Very light', grades: ['N', 'O', 'P', 'Q', 'R'] },
    { name: 'Light', grades: ['S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'] },
  ]);
  scale(doc, 922, 144, 143, 454, [
    { name: '', grades: ['Flawless', 'Internally flawless'], small: true },
    { name: 'Very very slightly included', grades: ['VVS1', 'VVS2'] },
    { name: 'Very slightly included', grades: ['VS1', 'VS2'] },
    { name: 'Slightly included', grades: ['SI1', 'SI2'] },
    { name: 'Included', grades: ['I1', 'I2', 'I3'] },
  ]);
}

function drawQr(doc, url) {
  const { modules } = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const { size, data } = modules;
  const x = 986, y = 671, box = 90;
  rect(doc, x, y, box, box, '#ffffff');
  const cell = box / size;
  doc.fillColor('#1a1a1a');
  for (let row = 0; row < size; row += 1) {
    let col = 0;
    while (col < size) {
      if (!data[row * size + col]) { col += 1; continue; }
      const start = col;
      while (col < size && data[row * size + col]) col += 1;
      doc.rect(x + start * cell, y + row * cell, (col - start) * cell, cell).fill();
    }
  }
  doc.link(x, y, box, box, url);
  text(doc, qrCaption, 976, 763, 103, 18,
    { size: 11, minSize: 8, color: '#555550', align: 'center', spacing: 0.3 });
}

function collectPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.once('error', reject);
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    doc.end();
  });
}

export async function renderCertificatePdf(slug) {
  await acquire();
  try {
    const cert = certificates.bySlug(slug);
    if (!cert) throw new HttpError(404, 'Сертификат не найден');
    const photo = await cleanPhoto(cert);
    const doc = new PDFDocument({ size: [W * S, H * S], margin: 0, compress: true,
      info: { Title: `Certificate ${cert.cert_number}`, Author: 'PALMIRA Jewels' } });
    setupFonts(doc);
    doc.save().scale(S);
    rect(doc, 0, 0, W, H, C.paper);
    doc.image(path.join(config.paths.public, 'assets', 'logo_jewels_dark.png'), 44, 40, { width: 200 });
    text(doc, 'CERTIFICATE OF AUTHENTICITY', 397, 42, 330, 22,
      { size: 11, weight: 'semibold', color: C.gold, spacing: 2, align: 'center' });
    text(doc, cert.cert_number, 397, 65, 330, 30, { size: 22, align: 'center' });
    drawLeft(doc, cert);
    drawPhoto(doc, photo);
    drawScales(doc);
    drawQr(doc, `${config.siteUrl}/verify/${cert.slug}`);
    doc.restore();
    return await collectPdf(doc);
  } finally {
    release();
  }
}
