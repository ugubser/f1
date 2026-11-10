import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readUIConfig} from '../ui-config.mjs';
import {configuredClient} from '../public/connection.js';

const token='unit-ui-application-token-at-least-32-characters';
test('UI env reads quoted tokens and publishes only the application credential',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'f1-ui-env-')),file=path.join(dir,'.env');
  try {
    await writeFile(file,`# private UI configuration\nF1_UI_API_TOKEN="${token}"\nF1_SUBSCRIPTION_TOKEN=never-publish-this\n`,{mode:0o600});
    assert.deepEqual(await readUIConfig(file),{apiToken:token});
    await chmod(file,0o644);await assert.rejects(readUIConfig(file),/Invalid UI configuration/);
    await chmod(file,0o600);await symlink(file,path.join(dir,'link'));await assert.rejects(readUIConfig(path.join(dir,'link')));
    for(const contents of ['', 'F1_UI_API_TOKEN=short', 'F1_UI_API_TOKEN="contains whitespace and is more than 32 characters"']) {
      await writeFile(file,contents);await assert.rejects(readUIConfig(file),/Invalid UI access token/);
    }
    await assert.rejects(readUIConfig(path.join(dir,'missing')));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('UI connects from fresh configuration on every load and sends the bearer only to the API',async()=>{
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push({url,options});
    return Response.json(url==='/ui-config.json'?{apiToken:token}:{ok:true});
  };
  try {
    for(let reload=0;reload<2;reload++)await(await configuredClient()).request('/system');
    assert.deepEqual(calls.map(c=>c.url),['/ui-config.json','/api/v1/system','/ui-config.json','/api/v1/system']);
    for(const call of calls) {
      assert.equal(call.url.includes(token),false);
      if(call.url==='/ui-config.json'){assert.equal(call.options.cache,'no-store');assert.equal(call.options.headers,undefined);}
      else assert.equal(call.options.headers.Authorization,'Bearer '+token);
    }
    globalThis.fetch=async()=>new Response('',{status:503});await assert.rejects(configuredClient(),/Check public\/\.env/);
    for(const apiToken of [undefined,'short','long but includes whitespace and cannot be valid']) {
      globalThis.fetch=async()=>Response.json({apiToken});await assert.rejects(configuredClient(),/configuration is invalid/);
    }
  } finally { globalThis.fetch=original; }
});
