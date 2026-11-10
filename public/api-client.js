export function mergeState(state,message){
  if(message.type==='snapshot')return state?.id===message.state.id&&state.sequence>=message.state.sequence?state:message.state;
  if(!state||message.epoch!==state.motionEpoch||message.viewSequence<=state.sequence)return state;
  const cars=new Map(state.cars.map(c=>[c.driverNumber,c]));
  for(const n of message.cars.remove)cars.delete(n);
  for(const patch of message.cars.upsert)cars.set(patch.driverNumber,{...cars.get(patch.driverNumber),...patch});
  return {...state,...message.changes,serverTime:message.serverTime,sequence:message.viewSequence,revision:message.revision,
    cars:[...cars.values()].sort((a,b)=>(a.position??999)-(b.position??999)||a.driverNumber-b.driverNumber)};
}
export class APIClient {
  constructor(token,{WebSocketImpl=globalThis.WebSocket,now=()=>performance.now()}={}){this.token=token;this.WebSocket=WebSocketImpl;this.now=now;this.current=null;}
  async request(path,{method='GET',body,signal}={}){
    const response=await fetch('/api/v1'+path,{method,headers:{Authorization:'Bearer '+this.token,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal});
    if(!response.ok){const data=await response.json();const error=new Error(data.error?.message||'API request failed.');error.code=data.error?.code;throw error;}
    if(response.status===204)return null;
    const data=await response.json();if(data?.motionEpoch&&this.current?.id===data.id&&data.sequence>this.current.sequence)this.current=data;
    return data;
  }
  async audio(clipId,signal){
    const response=await fetch('/api/v1/media/radio/'+encodeURIComponent(clipId),{headers:{Authorization:'Bearer '+this.token},signal});
    if(!response.ok)throw Error('This radio clip is unavailable.');return response.blob();
  }
  async stream(id,{onState,onCoordinates,onClock},{signal}={}){
    const ticket=await this.request('/views/'+id+'/stream-ticket',{method:'POST',body:{},signal});
    if(signal?.aborted)return;
    const url=new URL(ticket.url,location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const socket=new this.WebSocket(url.href);let sequence=0,minRtt=Infinity;this.current=null;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const ping=()=>{if(socket.readyState===1)socket.send(JSON.stringify({type:'ping',sentAt:this.now()}));};
      const timer=setInterval(ping,5000);timer.unref?.();
      const finish=error=>{if(settled)return;settled=true;clearInterval(timer);clearTimeout(initialTimer);signal?.removeEventListener('abort',abort);socket.close();error?reject(error):resolve();};
      const initialTimer=setTimeout(()=>finish(new Error('WebSocket state initialization timed out.')),5000);initialTimer.unref?.();
      const abort=()=>finish();signal?.addEventListener('abort',abort,{once:true});
      socket.addEventListener('open',()=>{if(signal?.aborted)return abort();socket.send(JSON.stringify({type:'auth',ticket:ticket.ticket}));ping();});
      socket.addEventListener('message',event=>{
        if(settled)return;
        try{
          if(typeof event.data!=='string'||event.data.length>4*1024*1024)throw Error('Invalid or oversized stream message.');
          const message=JSON.parse(event.data);
          if(message.type==='pong'){
            const rtt=this.now()-message.sentAt;if(rtt>=0&&rtt<minRtt){minRtt=rtt;onClock?.(message.serverTime-(message.sentAt+this.now())/2);}return;
          }
          if(!Number.isInteger(message.sequence)||message.sequence!==sequence+1)throw Error('Stream sequence gap; resynchronization required.');sequence=message.sequence;
          if(message.type==='error'){const error=new Error(message.message);error.code=message.code;throw error;}
          if(message.type==='snapshot'||message.type==='state'){if(message.type==='snapshot')clearTimeout(initialTimer);this.current=mergeState(this.current,message);onState(this.current);}
          else if(message.type==='coordinates')onCoordinates(message);
          else throw Error('Unsupported stream message.');
          socket.send(JSON.stringify({type:'ack',sequence}));
        }catch(error){finish(error);}
      });
      socket.addEventListener('error',()=>finish(new Error('WebSocket connection failed.')));
      socket.addEventListener('close',event=>{if(signal?.aborted)return finish();const error=new Error(event.code===4404?'This view expired or the server restarted. Reconnect to create a new view.':'The WebSocket stream closed.');error.code=event.code===4404?'VIEW_NOT_FOUND':event.code===4401?'STREAM_UNAUTHORIZED':'STREAM_CLOSED';finish(error);});
    });
  }
}
