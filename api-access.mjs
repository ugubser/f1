import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdir, open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {authFile} from './f1-auth.mjs';

export const apiTokenFile = path.join(path.dirname(authFile), 'api-access.key');
export async function readApiToken(file = apiTokenFile) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw Error('API token file must be private and owned by the service user.');
    const token = (await handle.readFile('utf8')).trim();
    if (token.length < 32 || /\s/.test(token)) throw Error('API access token must contain at least 32 characters and no whitespace.');
    return token;
  } finally { await handle.close(); }
}
export async function createApiToken(file = apiTokenFile) {
  await mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(randomBytes(32).toString('base64url') + '\n'); }
  finally { await handle.close(); }
}
export function bearerGuard(token) {
  if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw Error('Configure a private API access token of at least 32 characters.');
  const hash = value => createHash('sha256').update(value).digest();
  const expected = hash(token);
  return header => typeof header === 'string' && /^Bearer [^\s]+$/i.test(header) && timingSafeEqual(hash(header.slice(7)), expected);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'create') { await createApiToken(); console.log('API access token created. Use npm run api:token in your terminal to display it.'); }
    else if (process.argv[2] === 'show') {
      if (!process.stdout.isTTY) throw Error('Display the API token only in your own interactive terminal.');
      console.log(await readApiToken());
    } else throw Error('Use npm run api:setup or npm run api:token.');
  } catch (error) { console.error(error.code === 'EEXIST' ? 'API access is already configured. Existing token was preserved.' : error.code === 'ENOENT' ? 'Run npm run api:setup first.' : error.message); process.exitCode = 1; }
}
