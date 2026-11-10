import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AccountService} from '../services/account.mjs';
import {fakeLive} from './fixtures.mjs';
test('logout fences in-flight login; it cannot save credentials after sign-out',async()=>{
 const f=fakeLive();let complete;const account=new AccountService({...f,login:()=>new Promise(r=>{complete=r;})});
 const pending=account.login({email:'owner@example.invalid',password:'unit-password'});await assert.rejects(account.login({email:'owner@example.invalid',password:'x'}),/already in progress/);await account.logout();complete({value:'private',expiresAt:Date.now()+3600000});await assert.rejects(pending,/cancelled/);assert.equal((await account.status()).signedIn,false);
});
test('logout is ordered after an atomic token save already in progress',async()=>{
 let begin,finish;const entered=new Promise(r=>{begin=r;});let stored=false;const tokens={status:async()=>({signedIn:stored}),save:async()=>{begin();await new Promise(r=>{finish=r;});stored=true;},clear:async()=>{stored=false;}};
 const account=new AccountService({tokens,login:async()=>({value:'private'})});const pending=account.login({email:'owner@example.invalid',password:'x'});await entered;const logout=account.logout();finish();await assert.rejects(pending,/cancelled/);await logout;assert.equal(stored,false);
});
test('failed login preserves saved sign-in and secrets never appear in errors',async()=>{
 const f=fakeLive();await f.tokens.save({});const account=new AccountService({...f,login:async()=>{throw Error('unit-password');}});const body={email:'owner@example.invalid',password:'unit-password'};await assert.rejects(account.login(body),e=>!e.message.includes('unit-password'));assert.equal(body.password,'');assert.equal((await account.status()).signedIn,true);
});
