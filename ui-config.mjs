import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {parseEnv} from 'node:util';

export const uiEnvFile = new URL('./public/.env', import.meta.url);
export async function readUIConfig(file = uiEnvFile) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16384 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw Error('Invalid UI configuration file.');
    const env = parseEnv(await handle.readFile('utf8'));
    const apiToken = env.F1_UI_API_TOKEN;
    if (typeof apiToken !== 'string' || apiToken.length < 32 || /\s/.test(apiToken)) throw Error('Invalid UI access token.');
    // Deliberately publish only this browser credential, never other environment values.
    return {apiToken};
  } finally { await handle.close(); }
}
