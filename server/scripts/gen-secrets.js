import crypto from 'node:crypto';

const digits = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');

console.log(`
Готовые значения для .env — скопируйте их в файл:

SESSION_SECRET=${crypto.randomBytes(48).toString('base64url')}
PANEL_PATH=${digits(8)}${['ldb', 'edb'][crypto.randomInt(0, 2)]}${digits(22)}

PANEL_PATH — секретный адрес панели: она открывается по домен.com/<этот путь>.
Держите его в тайне: это второй рубеж защиты помимо логина с паролем.
`);
