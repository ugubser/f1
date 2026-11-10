import {createHash,randomBytes,createPublicKey,verify} from 'node:crypto';
import {mkdir,open,rename,unlink,lstat,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IDP='https://id.formula1.com';
const CONFIG='https://account.formula1.com/scripts/main.min.js';
const JWKS='https://api.formula1.com/static/jwks.json';
export class AuthError extends Error {}
export const authFile=path.join(os.homedir(),process.platform==='darwin'?'Library/Application Support/F1 Race Replay':'.local/share/f1-race-replay','session.json');
const headers={'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36','Accept-Language':'en-GB,en;q=0.9'};
export function parseAuthConfig(script){
  const object=/\bdavinci:\{([^}]*)\}/.exec(script)?.[1];
  const clientId=/\bclientId:"([^"]+)"/.exec(object||'')?.[1],policyId=/\bacrValues:"([^"]+)"/.exec(object||'')?.[1];
  if(!clientId||!policyId)throw new AuthError('F1 changed its sign-in configuration. Sign-in needs an update.');
  return {clientId,policyId};
}
export const pkceChallenge=verifier=>createHash('sha256').update(verifier).digest('base64url');
export function jwtParts(value){
  try{const parts=value.split('.');if(parts.length!==3)throw Error();return {header:JSON.parse(Buffer.from(parts[0],'base64url')),claims:JSON.parse(Buffer.from(parts[1],'base64url')),signature:Buffer.from(parts[2],'base64url'),signed:parts.slice(0,2).join('.')};}
  catch{throw new AuthError('F1 returned an invalid authentication token.');}
}
export function verifySubscription(value,keys,now=Date.now()){
  const token=jwtParts(value),key=keys.find(k=>k.kid===token.header.kid&&k.kty==='RSA');
  if(token.header.alg!=='RS256'||!key||!verify('RSA-SHA256',Buffer.from(token.signed),createPublicKey({key,format:'jwk'}),token.signature))throw new AuthError('The F1 subscription token could not be verified.');
  if(!Number.isFinite(token.claims.exp)||token.claims.exp*1000<=now+60000)throw new AuthError('The F1 sign-in has expired. Sign in again.');
  return {value,expiresAt:token.claims.exp*1000};
}
// No credentials or response bodies appear in errors, even when F1 echoes them.
export async function signIn(username,password,{fetchImpl=fetch,now=Date.now,signal}={}){
  const cookies=new Map();
  async function request(url,options={}){
    const parsed=new URL(url);
    if(parsed.origin!==IDP&&url!==CONFIG&&url!==JWKS)throw new AuthError('Unexpected F1 sign-in destination.');
    let response;
    try{response=await fetchImpl(url,{...options,headers:{...headers,...(parsed.origin===IDP&&cookies.size?{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')}:{}),...options.headers},redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});}
    catch{throw new AuthError('Could not reach F1 sign-in. Check your connection and try again.');}
    if(parsed.origin===IDP)for(const cookie of response.headers.getSetCookie()){
      const pair=cookie.split(';')[0],index=pair.indexOf('=');if(index>0)cookies.set(pair.slice(0,index),pair.slice(index+1));
    }
    if(!response.ok)throw new AuthError(`F1 sign-in returned HTTP ${response.status}. Check your account on formula1.com and try again.`);
    return response;
  }
  try{
    const config=parseAuthConfig(await(await request(CONFIG)).text());
    const verifier=randomBytes(48).toString('base64url'),state=randomBytes(24).toString('base64url');
    const query=new URLSearchParams({client_id:config.clientId,response_type:'code',response_mode:'pi.flow',scope:'openid',state,nonce:randomBytes(24).toString('base64url'),code_challenge:pkceChallenge(verifier),code_challenge_method:'S256',acr_values:config.policyId});
    const form=await(await request(IDP+'/as/authorize?'+query,{headers:{'X-Requested-With':'ping-sdk'}})).json();
    const next=new URL(form?._links?.next?.href);
    if(next.origin!==IDP||next.username||next.password||next.hash||!form.interactionId||!form.id||!form.eventName)throw new AuthError('Unexpected F1 sign-in form. No credentials were submitted.');
    const submitted=await(await request(next.href,{method:'POST',headers:{'X-Requested-With':'ping-sdk',interactionId:form.interactionId,'Content-Type':'application/json'},body:JSON.stringify({id:form.id,eventName:form.eventName,interactionId:form.interactionId,parameters:{eventType:'submit',data:{actionKey:'SIGNIN',formData:{username,password}}}})})).json();
    if(submitted.status!=='COMPLETED')throw new AuthError('F1 did not complete sign-in. Check your credentials, account and any required verification on formula1.com.');
    if(submitted.authorizeResponse?.state!==state||typeof submitted.authorizeResponse?.code!=='string')throw new AuthError('F1 sign-in state verification failed.');
    const grant=await(await request(IDP+'/as/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:config.clientId,code:submitted.authorizeResponse.code,code_verifier:verifier})})).json();
    const subscription=jwtParts(grant.access_token).claims.subscriptionToken;
    if(typeof subscription!=='string')throw new AuthError('This F1 account did not return a subscription token. Check your F1 TV subscription.');
    const jwks=await(await request(JWKS)).json();
    return verifySubscription(subscription,jwks.keys,now());
  }catch(error){if(error instanceof AuthError)throw error;throw new AuthError('Unexpected response from F1 sign-in. No token was saved.');}
  finally{cookies.clear();password=null;}
}
export class TokenStore{
  constructor(file=authFile,{now=Date.now}={}){this.file=file;this.now=now;}
  async read(){
    let handle;
    try{
      handle=await open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW);
      const info=await handle.stat();
      if(!info.isFile()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))throw new AuthError('F1 token storage must belong to you and have private file permissions. Sign in again through the app or API.');
      const stored=JSON.parse(await handle.readFile('utf8'));
      if(typeof stored.value!=='string'||!Number.isFinite(stored.expiresAt)||jwtParts(stored.value).claims.exp*1000!==stored.expiresAt)throw Error();
      if(stored.expiresAt<=this.now()+60000)throw new AuthError('F1 sign-in expired. Sign in through the app or API.');
      return stored;
    }catch(error){if(error instanceof AuthError)throw error;if(error.code==='ENOENT')throw new AuthError('Sign in through the app or API first.');throw new AuthError('F1 token storage could not be read safely. Sign in again through the app or API.');}
    finally{await handle?.close();}
  }
  async status(){try{const token=await this.read();return {signedIn:true,expiresAt:token.expiresAt};}catch(error){return {signedIn:false,expiresAt:null,message:error.message};}}
  async save(token){
    const directory=path.dirname(this.file);await mkdir(directory,{recursive:true,mode:0o700});
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||(process.getuid&&info.uid!==process.getuid()))throw new AuthError('F1 token directory is not a private directory owned by you.');
    await chmod(directory,0o700);
    const temp=path.join(directory,'.session-'+randomBytes(12).toString('hex'));
    let handle;
    try{handle=await open(temp,'wx',0o600);await handle.writeFile(JSON.stringify({version:1,value:token.value,expiresAt:token.expiresAt}));await handle.close();handle=null;await rename(temp,this.file);}
    finally{await handle?.close();await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  async clear(){try{await unlink(this.file);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
