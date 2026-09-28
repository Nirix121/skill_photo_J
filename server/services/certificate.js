import { config } from '../config.js';

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

export const GEMSTONE_COLUMNS = ['cut', 'qty', 'quality', 'color', 'carat'];

function normalizeGemstones(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];

  return list
    .map((row) => Object.fromEntries(GEMSTONE_COLUMNS.map((c) => [c, str(row?.[c], 60)])))
    .filter((row) => GEMSTONE_COLUMNS.some((c) => row[c]))
    .slice(0, 12);
}

/** Приводит данные формы к виду для базы и собирает ошибки заполнения. */
export function parseForm(body) {
  const data = {
    cert_number: str(body.cert_number, 40),
    folder: str(body.folder, 8).toLowerCase(),
    issue_date: str(body.issue_date, 80),
    item_number: str(body.item_number, 80),
    description: str(body.description, 120),
    size: str(body.size, 60),
    metal: str(body.metal, 80),
    fineness: str(body.fineness, 40),
    weight: str(body.weight, 60),
    gemstones: normalizeGemstones(body.gemstones),
  };

  const errors = [];
  if (!data.cert_number) {
    errors.push('Укажите номер сертификата');
  } else if (!/^[0-9a-z]+$/i.test(data.cert_number)) {
    errors.push('Номер сертификата может состоять только из букв и цифр');
  }
  if (!config.folders.includes(data.folder)) {
    errors.push('Выберите папку хранения: ldb или edb');
  }
  if (!data.issue_date) errors.push('Укажите дату выдачи');
  if (!data.description) errors.push('Укажите описание изделия');

  return { data, errors };
}

/** Данные для шаблона сертификата и страницы проверки. */
export function toView(cert) {
  return {
    ...cert,
    verifyUrl: `${config.siteUrl}/verify/${cert.slug}`,
    gemstones: cert.gemstones?.length ? cert.gemstones : [],
  };
}
