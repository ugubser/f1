import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApiToken,readApiToken,bearerGuard} from '../api-access.mjs';
test('API access keys are random private files, never overwritten, and reject symlinks or public permissions',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'f1-access-test-')),file=path.join(dir,'access.key');try{
  await createApiToken(file);const token=await readApiToken(file);assert.equal(token.length,43);assert.equal((await stat(file)).mode&0o777,0o600);await assert.rejects(createApiToken(file),e=>e.code==='EEXIST');assert.equal(await readApiToken(file),token);await symlink(file,path.join(dir,'link'));await assert.rejects(readApiToken(path.join(dir,'link')));await chmod(file,0o644);await assert.rejects(readApiToken(file),/private/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('bearer guard requires a configured token and checks the entire scheme/value',()=>{
 assert.throws(()=>bearerGuard('short'),/32/);const guard=bearerGuard('unit-access-token-at-least-32-characters');assert.equal(guard('Bearer unit-access-token-at-least-32-characters'),true);for(const value of [undefined,'','Basic unit-access-token-at-least-32-characters','Bearer wrong','Bearer unit-access-token-at-least-32-characters extra'])assert.equal(Boolean(guard(value)),false);
});
