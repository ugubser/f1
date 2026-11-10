import {createHash} from 'node:crypto';
import {AuthError,TokenStore} from './f1-auth.mjs';
import {LiveState,LIVE_TOPICS} from './live-state.mjs';
const ORIGIN='https://livetiming.formula1.com';
const RS='\x1e',LIMIT=20*1024*1024;
const digest=value=>createHash('sha256').update(value).digest('hex');
class ConnectionError extends Error {}
export class SignalRFrames{
  constructor(){this.buffer='';}
  push(text){
    if(typeof text!=='string')throw Error('Expected text frames.');
    this.buffer+=text;if(this.buffer.length>LIMIT)throw Error('F1 frame exceeds the size limit.');
    const messages=[];let split;
    while((split=this.buffer.indexOf(RS))>=0){const frame=this.buffer.slice(0,split);this.buffer=this.buffer.slice(split+1);if(frame)messages.push(JSON.parse(frame));}
    return messages;
  }
}
export class F1LiveClient{
  constructor({tokens=new TokenStore(),fetchImpl=fetch,WebSocketImpl=WebSocket,now=Date.now,retryBase=1000}={}){
    this.tokens=tokens;this.fetch=fetchImpl;this.WebSocket=WebSocketImpl;this.now=now;this.retryBase=retryBase;this.store=new LiveState();this.connection={state:'disconnected',message:'Not connected to F1.'};this.generation=0;this.wanted=false;this.failures=0;
  }
  async authStatus(){
    try{const token=await this.tokens.read();if(this.rejectedDigest===digest(token.value))return {signedIn:false,expiresAt:null,message:'F1 rejected the saved sign-in. Run npm run f1:login again.'};return {signedIn:true,expiresAt:token.expiresAt};}
    catch(error){return {signedIn:false,expiresAt:null,message:error.message};}
  }
  async snapshot(){
    const auth=await this.authStatus();if(!auth.signedIn&&this.wanted)this.disconnect('auth_required',auth.message);
    const snapshot=this.store.snapshot();
    const connection=this.connection.state==='streaming'&&(!snapshot.updatedAt||this.now()-snapshot.updatedAt>30000)?{state:'stale',message:'Connected to F1, but no fresh source data is arriving.'}:this.connection;
    return {...snapshot,connection,auth};
  }
  async connect(){
    if(this.wanted)return;
    const generation=++this.generation;this.wanted=true;
    try{
      const token=await this.tokens.read();if(generation!==this.generation||!this.wanted)return;
      if(this.rejectedDigest===digest(token.value))throw new AuthError('F1 rejected the saved sign-in. Run npm run f1:login again.');
      this.failures=0;this.rejectedDigest=null;this.store.reset();this.attempt();
    }catch(error){if(generation===this.generation){this.wanted=false;this.connection={state:'auth_required',message:error instanceof AuthError?error.message:'F1 sign-in is unavailable.'};}throw error;}
  }
  disconnect(state='disconnected',message='Disconnected from F1.'){
    this.wanted=false;this.generation++;clearTimeout(this.retryTimer);clearInterval(this.watchdog);clearTimeout(this.openTimeout);this.abort?.abort();this.socket?.close();this.socket=null;this.connection={state,message};
  }
  async attempt(){
    const generation=++this.generation;this.connection={state:this.failures?'reconnecting':'connecting',message:this.failures?'Reconnecting to F1; requesting a fresh snapshot…':'Connecting directly to F1…'};
    this.abort=new AbortController();let socket,token;
    const current=()=>generation===this.generation&&this.wanted;
    try{
      token=await this.tokens.read();if(!current())return;
      const cookies=new Map();
      const request=async(url,method)=>{
        const response=await this.fetch(url,{method,headers:{Authorization:'Bearer '+token.value,...(cookies.size?{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')}:{})},redirect:'manual',signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(20000)])});
        if(response.status===401||response.status===403)throw new AuthError('F1 rejected the subscription sign-in. Run npm run f1:login again and check your subscription.');
        for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],index=pair.indexOf('=');if(index>0)cookies.set(pair.slice(0,index),pair.slice(index+1));}
        // F1's OPTIONS bootstrap returns 405 but still establishes ALB affinity.
        // Only accept that exact response when it supplied the required cookie;
        // the subsequent authenticated POST must succeed normally.
        const affinityBootstrap=method==='OPTIONS'&&response.status===405&&cookies.has('AWSALBCORS');
        if(!response.ok&&!affinityBootstrap)throw new ConnectionError(`F1 ${method==='OPTIONS'?'connection setup':'timing negotiation'} returned HTTP ${response.status}.`);
        if(method==='OPTIONS'&&!cookies.has('AWSALBCORS'))throw new ConnectionError('F1 connection setup did not supply the required affinity cookie.');
        return response;
      };
      await request(ORIGIN+'/signalrcore/negotiate','OPTIONS');if(!current())return;
      const response=await request(ORIGIN+'/signalrcore/negotiate?negotiateVersion=1','POST');
      let negotiated;try{negotiated=await response.json();}catch{throw new ConnectionError('F1 timing negotiation returned an invalid response.');}if(!current())return;
      if(!negotiated||negotiated.url||typeof negotiated.connectionToken!=='string'||!negotiated.availableTransports?.some(t=>t.transport==='WebSockets'&&t.transferFormats?.includes('Text')))throw new ConnectionError('F1 did not offer a compatible direct WebSocket connection.');
      const url=new URL('wss://livetiming.formula1.com/signalrcore');url.searchParams.set('id',negotiated.connectionToken);
      socket=new this.WebSocket(url.href,{headers:{Authorization:'Bearer '+token.value,Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')}});this.socket=socket;
      const parser=new SignalRFrames();let handshaken=false,ended=false,subscribed=false,lastReceived=this.now();const queued=[];const connectedAt=this.now();
      const fail=(auth=false,message)=>{
        if(ended||!current())return;ended=true;
        if(auth)this.rejectedDigest=digest(token.value);
        this.failed(generation,auth,message);
      };
      const applySnapshot=(result,utc)=>{
        this.store.reset();
        if(result.SessionInfo)this.store.apply('SessionInfo',result.SessionInfo,utc,{snapshot:true});
        for(const topic of LIVE_TOPICS)if(topic!=='SessionInfo'&&result[topic]!=null)this.store.apply(topic,result[topic],utc,{snapshot:true});
      };
      const updateStatus=()=>{
        const status=this.store.raw.SessionStatus?.Status;
        this.connection=status==='Started'?{state:'streaming',message:'Receiving F1 live timing.'}:{state:'waiting',message:'Connected to F1. Waiting for an active session.'};
      };
      socket.addEventListener('open',()=>{if(!current())return;socket.send(JSON.stringify({protocol:'json',version:1})+RS);});
      this.openTimeout=setTimeout(()=>fail(false,'F1 connection timed out.'),20000);this.openTimeout.unref?.();
      socket.addEventListener('message',event=>{
        if(!current())return;lastReceived=this.now();
        try{
          for(const message of parser.push(event.data)){
            if(!handshaken){if(!message||typeof message!=='object'||Object.keys(message).length)throw Error();handshaken=true;socket.send(JSON.stringify({type:1,invocationId:'1',target:'Subscribe',arguments:[LIVE_TOPICS]})+RS);continue;}
            if(message.type===3&&message.invocationId==='1'){
              if(message.error){fail(true,'F1 did not authorize the timing subscription. Sign in again.');return;}
              clearTimeout(this.openTimeout);
              const utc=message.result?.Heartbeat?.Utc;
              if(!Number.isFinite(Date.parse(utc)))throw Error();
              applySnapshot(message.result,utc);subscribed=true;
              for(const [topic,patch,time] of queued.sort((a,b)=>Date.parse(a[2])-Date.parse(b[2])))this.store.apply(topic,patch,time);
              queued.length=0;
              updateStatus();
            }else if(message.type===1&&message.target?.toLowerCase()==='feed'){
              const [topic,patch,utc]=message.arguments||[];
              if(!Number.isFinite(Date.parse(utc)))throw Error();
              if(this.now()-connectedAt>30000)this.failures=0;
              if(!subscribed){if(queued.length>=1000)throw Error();queued.push([topic,patch,utc]);continue;}
              this.store.apply(topic,patch,utc);updateStatus();
            }else if(message.type===7){fail(false,'F1 closed the timing connection.');return;}
          }
        }catch{fail(false,'F1 sent an unsupported timing message.');}
      });
      socket.addEventListener('error',()=>fail(false,'The F1 connection failed.'));
      socket.addEventListener('close',()=>fail(false,'The F1 connection closed.'));
      this.watchdog=setInterval(async()=>{
        if(!current())return;
        try{await this.tokens.read();}catch{fail(true,'F1 sign-in expired or was removed. Run npm run f1:login again.');return;}
        if(this.now()-lastReceived>30000){fail(false,'F1 stopped sending data.');return;}
        if(socket.readyState===1)socket.send(JSON.stringify({type:6})+RS);
      },10000);this.watchdog.unref?.();
    }catch(error){if(current()){if(error instanceof AuthError&&token)this.rejectedDigest=digest(token.value);this.failed(generation,error instanceof AuthError,error instanceof AuthError||error instanceof ConnectionError?error.message:'Could not establish the F1 timing connection.');}}
  }
  failed(generation,auth,message){
    if(generation!==this.generation||!this.wanted)return;
    this.generation++;clearInterval(this.watchdog);clearTimeout(this.openTimeout);this.abort?.abort();this.socket?.close();this.socket=null;
    if(auth){this.wanted=false;this.connection={state:'auth_required',message};return;}
    this.failures++;
    if(this.failures>=5){this.wanted=false;this.connection={state:'error',message:message+' Connection attempts stopped; click Connect to try again.'};return;}
    const delay=Math.min(30000,this.retryBase*2**(this.failures-1));
    this.connection={state:'reconnecting',message:message+' Reconnecting…',retryAt:this.now()+delay};
    this.retryTimer=setTimeout(()=>this.attempt(),delay);this.retryTimer.unref?.();
  }
  async radio(id){
    const event=this.store.events.get(id);if(event?.kind!=='radio'||!event.sourceUrl)throw Error('Radio clip unavailable.');
    const url=new URL(event.sourceUrl);if(url.origin!==ORIGIN||!url.pathname.startsWith('/static/')||!url.pathname.endsWith('.mp3'))throw Error('Radio clip unavailable.');
    const token=await this.tokens.read();
    const response=await this.fetch(url.href,{headers:{Authorization:'Bearer '+token.value},redirect:'manual',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error('F1 could not provide this radio clip.');
    const chunks=[];let length=0;for await(const chunk of response.body){length+=chunk.length;if(length>20*1024*1024)throw Error('Radio clip exceeds the size limit.');chunks.push(chunk);}
    return Buffer.concat(chunks);
  }
}
