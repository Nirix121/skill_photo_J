import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { admins } from '../db.js';
import { hashPassword } from '../auth.js';

const rl = readline.createInterface({ input: stdin, output: stdout });

/** Ввод пароля без отображения символов в терминале. */
async function askSecret(question) {
  stdout.write(question);
  const wasRaw = stdin.isRaw;
  if (stdin.isTTY) stdin.setRawMode(true);

  const password = await new Promise((resolve) => {
    let value = '';
    const onData = (chunk) => {
      const char = chunk.toString('utf8');
      if (char === '\r' || char === '\n' || char === '') {
        stdin.off('data', onData);
        resolve(value);
      } else if (char === '') {
        stdout.write('\n');
        process.exit(130);
      } else if (char === '' || char === '\b') {
        value = value.slice(0, -1);
      } else if (char >= ' ') {
        value += char;
      }
    };
    stdin.on('data', onData);
  });

  if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
  stdout.write('\n');
  return password;
}

const username = (await rl.question('Логин администратора: ')).trim();
if (!username) {
  console.error('Логин не может быть пустым');
  process.exit(1);
}

const password = await askSecret('Пароль (символы не отображаются): ');
if (password.length < 10) {
  console.error('Пароль должен быть не короче 10 символов');
  process.exit(1);
}

const repeat = await askSecret('Повторите пароль: ');
if (password !== repeat) {
  console.error('Пароли не совпадают');
  process.exit(1);
}

const existed = Boolean(admins.byUsername(username));
admins.upsert(username, hashPassword(password));
rl.close();

console.log(existed ? `\nПароль для «${username}» обновлён.\n` : `\nАдминистратор «${username}» создан.\n`);
