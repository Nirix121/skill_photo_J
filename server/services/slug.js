import crypto from 'node:crypto';
import { config } from '../config.js';
import { certificates } from '../db.js';

/** Случайная строка из цифр криптостойким генератором. */
function randomDigits(length) {
  let out = '';
  while (out.length < length) out += crypto.randomInt(0, 10);
  return out;
}

export function buildSlug(certNumber, folder, code) {
  return `${certNumber}${folder}${code}`;
}

/**
 * Код и адрес сертификата. Совпадения исключены: адрес проверяется по базе,
 * а при удалении сертификата он освобождается и может быть выдан заново.
 */
export function allocateSlug(certNumber, folder) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = randomDigits(config.codeDigits);
    const slug = buildSlug(certNumber, folder, code);
    if (!certificates.slugExists(slug)) return { code, slug };
  }
  throw new Error('Не удалось подобрать свободный адрес — попробуйте ещё раз');
}
