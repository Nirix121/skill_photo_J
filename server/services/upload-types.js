import fs from 'node:fs';

const PHOTO_FORMATS = [
  {
    mime: 'image/jpeg',
    extension: 'jpg',
    matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    mime: 'image/png',
    extension: 'png',
    matches: (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  },
  {
    mime: 'image/webp',
    extension: 'webp',
    matches: (bytes) => bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
  },
];

export function photoFormat(bytes) {
  return PHOTO_FORMATS.find((format) => format.matches(bytes)) ?? null;
}

export function isPdf(head, tail = head) {
  return head.length >= 8 && head.toString('ascii', 0, 5) === '%PDF-'
    && tail.includes(Buffer.from('%%EOF'));
}

/** Check old stored uploads too; their original extensions may be executable. */
export function storedUploadType(filename, kind) {
  const fd = fs.openSync(filename, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 12));
    fs.readSync(fd, head, 0, head.length, 0);
    if (kind === 'photo') return photoFormat(head)?.mime ?? null;
    if (kind !== 'document') return null;
    const tail = Buffer.alloc(Math.min(size, 1024));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return isPdf(head, tail) ? 'application/pdf' : null;
  } finally {
    fs.closeSync(fd);
  }
}
