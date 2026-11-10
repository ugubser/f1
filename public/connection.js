import {APIClient} from './api-client.js';

export async function configuredClient() {
  const response = await fetch('/ui-config.json', {cache:'no-store', credentials:'omit'});
  if (!response.ok) throw Error('UI access is not configured. Check public/.env on the server and restart it.');
  const config = await response.json();
  if (typeof config.apiToken !== 'string' || config.apiToken.length < 32 || /\s/.test(config.apiToken)) throw Error('The UI access configuration is invalid. Check public/.env and restart the server.');
  return new APIClient(config.apiToken);
}
