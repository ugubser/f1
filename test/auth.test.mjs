import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,readFile,stat,chmod,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseAuthConfig,pkceChallenge,signIn,verifySubscription,TokenStore} from '../f1-auth.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'unit-test'};
const now=Date.now();
function jwt(claims){const content=[{alg:'RS256',kid:'unit-test'},claims].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');return content+'.'+sign('RSA-SHA256',Buffer.from(content),privateKey).toString('base64url');}
const subscription=jwt({exp:Math.floor(now/1000)+3600});
const outer=jwt({subscriptionToken:subscription});
const config='settings={davinci:{clientId:"public-client",acrValues:"public-policy"}}';
const reply=(body,status=200,headers={})=>new Response(typeof body==='string'?body:JSON.stringify(body),{status,headers});
function mockLogin({destination='https://id.formula1.com/flow',wrongState=false,reject=false}={}){
  const calls=[];let state;
  const fetchImpl=async(url,options)=>{
    const u=new URL(url);calls.push({url:u,options});
    assert.equal(options.redirect,'manual');
    if(u.hostname==='account.formula1.com')return reply(config);
    if(u.pathname==='/as/authorize'){state=u.searchParams.get('state');assert.equal(u.searchParams.get('code_challenge_method'),'S256');return reply({_links:{next:{href:destination}},interactionId:'interaction',id:'flow',eventName:'submit' },200,{'set-cookie':'session=unit-test; Secure; HttpOnly'});}
    if(u.pathname==='/flow'){
      assert.equal(options.headers.Cookie,'session=unit-test');assert.deepEqual(JSON.parse(options.body).parameters.data.formData,{username:'test@example.invalid',password:'not-a-real-password'});
      return reply({status:reject?'FAILED':'COMPLETED',message:'not-a-real-password',authorizeResponse:{state:wrongState?'wrong':state,code:'unit-code'}});
    }
    if(u.pathname==='/as/token'){assert.equal(options.body.get('code'),'unit-code');assert.equal(pkceChallenge(options.body.get('code_verifier')),calls[1].url.searchParams.get('code_challenge'));return reply({access_token:outer});}
    if(u.hostname==='api.formula1.com'){assert.equal(options.headers.Cookie,undefined);return reply({keys:[jwk]});}
    throw Error('Unexpected mock request');
  };
  return {fetchImpl,calls};
}
test('F1 configuration and PKCE use the published flow without hardcoded client IDs',()=>{
  assert.deepEqual(parseAuthConfig(config),{clientId:'public-client',policyId:'public-policy'});
  assert.throws(()=>parseAuthConfig('missing'),/configuration/);
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
test('sign-in carries cookies, checks state/PKCE, verifies subscription and returns no password',async()=>{
  const mock=mockLogin();const result=await signIn('test@example.invalid','not-a-real-password',{...mock,now:()=>now});
  assert.equal(result.value,subscription);assert.ok(result.expiresAt>now);assert.deepEqual(Object.keys(result).sort(),['expiresAt','value']);assert.equal(mock.calls.length,5);
});
test('credentials never follow a foreign origin or a sign-in state mismatch',async()=>{
  const foreign=mockLogin({destination:'https://id.formula1.com.evil.invalid/flow'});
  await assert.rejects(signIn('test@example.invalid','not-a-real-password',foreign),/No credentials were submitted/);assert.equal(foreign.calls.length,2);
  const state=mockLogin({wrongState:true});await assert.rejects(signIn('test@example.invalid','not-a-real-password',state),/state verification/);assert.equal(state.calls.length,3);
});
test('upstream messages and transport errors cannot echo credentials into errors',async()=>{
  await assert.rejects(signIn('test@example.invalid','not-a-real-password',mockLogin({reject:true})),error=>!error.message.includes('not-a-real-password'));
  await assert.rejects(signIn('test@example.invalid','not-a-real-password',{fetchImpl:async()=>{throw Error('not-a-real-password');}}),error=>!error.message.includes('not-a-real-password'));
});
test('subscription signatures, algorithms and expiry are validated',()=>{
  assert.equal(verifySubscription(subscription,[jwk],now).value,subscription);
  assert.throws(()=>verifySubscription(subscription+'x',[jwk],now),/verified/);
  assert.throws(()=>verifySubscription(subscription,[],now),/verified/);
  assert.throws(()=>verifySubscription(jwt({exp:Math.floor(now/1000)-1}),[jwk],now),/expired/);
});
test('token storage is private, outside source files, atomically replaceable and removable',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'f1-auth-test-')),file=path.join(dir,'private','session.json');
  try{
    const store=new TokenStore(file,{now:()=>now});assert.equal((await store.status()).signedIn,false);
    const token=verifySubscription(subscription,[jwk],now);await store.save({...token,password:'must-not-save'});
    assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(path.dirname(file))).mode&0o777,0o700);
    assert.equal((await readFile(file,'utf8')).includes('must-not-save'),false);assert.equal((await store.read()).value,subscription);
    const status=await store.status();assert.equal(status.signedIn,true);assert.equal(JSON.stringify(status).includes(subscription),false);
    await store.save(token);await chmod(file,0o644);await assert.rejects(store.read(),/private file permissions/);
    await store.clear();assert.equal((await store.status()).signedIn,false);await store.clear();
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('expired and symlinked token files are never accepted',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'f1-auth-test-'));
  try{
    const store=new TokenStore(path.join(dir,'real.json'),{now:()=>now+7200000});await store.save({value:subscription,expiresAt:JSON.parse(Buffer.from(subscription.split('.')[1],'base64url')).exp*1000});await assert.rejects(store.read(),/expired/);
    const link=new TokenStore(path.join(dir,'link.json'),{now:()=>now});await symlink(store.file,link.file);await assert.rejects(link.read(),/safely/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('CLI refuses non-interactive credentials, including environment variables',()=>{
  const result=spawnSync(process.execPath,['auth-cli.mjs','login'],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,F1_USERNAME:'test@example.invalid',F1_PASSWORD:'not-a-real-password'}});
  assert.equal(result.status,1);assert.match(result.stderr,/own terminal/);assert.equal(result.stdout.includes('not-a-real-password'),false);
});
