// Real provider data and the same presentation buffer used by the web client.
// Runs an isolated loopback API process; does not alter another client's view.
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {WebSocket} from 'ws';
import {createReplayServer} from '../server.mjs';
import {MotionBuffer} from '../public/motion-buffer.js';
import {mergeState} from '../public/api-client.js';
const seconds=Number(process.env.F1_BENCHMARK_SECONDS||6),token=randomBytes(32).toString('base64url');
if(!Number.isFinite(seconds)||seconds<2||seconds>30)throw Error('Benchmark duration must be 2..30 seconds per speed.');
const server=createReplayServer({apiToken:token});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port+'/api/v1';
async function api(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(data.error?.message||'Benchmark request failed');return data;}
const results=[];
try{
 const view=await api('/views',{source:'history',raceId:9590});let ready=view;
 const deadline=Date.now()+180000;while(ready.status==='loading'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,250));ready=await api('/views/'+view.id);}
 if(ready.status!=='ready')throw Error('Real Monza data could not be loaded.');
 for(const speed of [1,10,60]){
  await api('/views/'+view.id+'/playback',{action:'seek',time:ready.playback.start+(ready.playback.end-ready.playback.start)*.4});
  await api('/views/'+view.id+'/playback',{action:'speed',speed});
  const buffer=new MotionBuffer(),ticket=await api('/views/'+view.id+'/stream-ticket',{}),ws=new WebSocket(base.replace('/api/v1','').replace('http:','ws:')+ticket.url);
  let current=null,messages=0,bytes=0,chunks=0,error=null,minRtt=Infinity,finished=false;
  const ping=()=>ws.send(JSON.stringify({type:'ping',sentAt:performance.now()}));
  ws.on('error',e=>{error=e;});ws.on('close',()=>{if(!finished)error=new Error('Benchmark stream closed unexpectedly.');});
  ws.on('open',()=>{ws.send(JSON.stringify({type:'auth',ticket:ticket.ticket}));ping();});
  ws.on('message',raw=>{
   try{
    const m=JSON.parse(raw);messages++;bytes+=Buffer.byteLength(raw);
    if(m.type==='pong'){const now=performance.now(),rtt=now-m.sentAt;if(rtt<minRtt){minRtt=rtt;buffer.setOffset(m.serverTime-(m.sentAt+now)/2);}return;}
    if(m.type==='snapshot'||m.type==='state'){current=mergeState(current,m);buffer.state(current);}
    else if(m.type==='coordinates'){buffer.coordinates(m);chunks++;}
    else if(m.type==='error')throw Error(m.code);
    ws.send(JSON.stringify({type:'ack',sequence:m.sequence}));
   }catch(e){error=e;}
  });
  const connected=Date.now()+5000;while(!buffer.points.size&&!error&&Date.now()<connected)await new Promise(r=>setTimeout(r,5));if(error)throw error;if(!buffer.points.size)throw Error('Coordinate buffer did not initialize.');
  const commandStart=performance.now(),playing=await api('/views/'+view.id+'/playback',{action:'play'}),commandMs=performance.now()-commandStart;current=playing;buffer.state(playing);
  const primed=Date.now()+5000;while((buffer.epoch!==playing.motionEpoch||!buffer.points.size)&&!error&&Date.now()<primed)await new Promise(r=>setTimeout(r,5));if(error)throw error;
  const t0=performance.now(),first=buffer.time().time;let frames=0,changed=0,underruns=0,previous=null;
  while(performance.now()-t0<seconds*1000){
   if(error)throw error;const sample=buffer.time(),p=buffer.location(81);frames++;if(sample.buffering)underruns++;if(p){const key=p.x+'/'+p.y;if(key!==previous)changed++;previous=key;}await new Promise(r=>setTimeout(r,1000/60));
  }
  const elapsed=performance.now()-t0,last=buffer.time().time;
  finished=true;ws.terminate();await api('/views/'+view.id+'/playback',{action:'pause'});
  const result={speed,elapsedSeconds:+(elapsed/1000).toFixed(2),replaySeconds:+((last-first)/1000).toFixed(2),renderFrames:frames,distinctPositionFrames:changed,bufferUnderruns:underruns,coordinateChunks:chunks,networkMessages:messages,networkKB:+(bytes/1024).toFixed(1),controlMs:+commandMs.toFixed(1)};results.push(result);console.log(JSON.stringify(result));
  if(underruns||changed<frames*.95||Math.abs((last-first)/elapsed-speed)>.1)throw Error(`Playback benchmark failed at ${speed}x.`);
 }
 if(process.env.F1_BENCHMARK_OUTPUT)await writeFile(process.env.F1_BENCHMARK_OUTPUT,JSON.stringify({session:9590,results},null,2));
}finally{server.shutdown();await new Promise(r=>server.close(r));}
