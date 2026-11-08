import http from 'node:http';
import {readFile, writeFile, mkdir, stat} from 'node:fs/promises';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {compactLocations} from './public/replay.js';
const ROOT=fileURLToPath(new URL('.',import.meta.url));
const CACHE=path.join(ROOT,'.cache');
await mkdir(CACHE,{recursive:true});
let tail=Promise.resolve();
const inflight=new Map();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// One outgoing request at a time, below the free API's per-second limit.
function upstream(endpoint,params) {
  const query=new URLSearchParams(params).toString(), key=endpoint+'?'+query;
  if(inflight.has(key)) return inflight.get(key);
  const job=(async()=>{
    const filename=path.join(CACHE,createHash('sha256').update(key).digest('hex')+'.json.gz');
    try {
      const info=await stat(filename);
      if(endpoint!=='sessions' || Date.now()-info.mtimeMs<3600000) return JSON.parse(gunzipSync(await readFile(filename)));
    } catch {}
    const work=tail.then(async()=>{
      for(let attempt=0;attempt<5;attempt++) {
        await pause(attempt ? 2500*2**attempt : 450);
        const res=await fetch('https://api.openf1.org/v1/'+key,{signal:AbortSignal.timeout(90000)});
        if(res.status===429 || res.status>=500) {if(attempt<4) continue;}
        if(!res.ok) throw new Error(`OpenF1 returned ${res.status}. Try again shortly; recent sessions may require paid access.`);
        let data=await res.json();
        if(!Array.isArray(data)) throw new Error('Unexpected OpenF1 response.');
        if(endpoint==='location') data=compactLocations(data);
        // Cache completed historical sessions only. Never cache empty results.
        if(data.length) await writeFile(filename,gzipSync(JSON.stringify(data)));
        return data;
      }
    });
    tail=work.catch(()=>{});
    return work;
  })().finally(()=>inflight.delete(key));
  inflight.set(key,job);return job;
}
const number=(value,name)=>{if(!/^\d{1,8}$/.test(value??'')) throw new Error(`Invalid ${name}`); return value;};
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
function json(res,data,status=200){const body=Buffer.from(JSON.stringify(data));const zipped=gzipSync(body);res.writeHead(status,{'Content-Type':'application/json','Content-Encoding':'gzip','Cache-Control':'no-store'});res.end(zipped);}
const server=http.createServer(async(req,res)=>{
  try {
    if(req.method!=='GET') return json(res,{error:'Method not allowed'},405);
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/races') {
      const year=number(url.searchParams.get('year'),'year');
      if(+year<2023||+year>new Date().getUTCFullYear()) return json(res,{error:'Choose a year from 2023 through the current year.'},400);
      const races=await upstream('sessions',{year,session_name:'Race'});
      return json(res,races.filter(s=>!s.is_cancelled && Date.parse(s.date_end)<Date.now()-3*3600000).sort((a,b)=>a.date_start.localeCompare(b.date_start)));
    }
    if(url.pathname==='/api/race') {
      const session_key=number(url.searchParams.get('session'),'session');
      const [drivers,laps,positions]=await Promise.all(['drivers','laps','position'].map(e=>upstream(e,{session_key})));
      return json(res,{drivers,laps,positions});
    }
    if(url.pathname==='/api/trajectory') {
      const session_key=number(url.searchParams.get('session'),'session'), driver_number=number(url.searchParams.get('driver'),'driver');
      return json(res,await upstream('location',{session_key,driver_number}));
    }
    const allowed={'/':'index.html','/app.js':'app.js','/replay.js':'replay.js','/style.css':'style.css'};
    const file=allowed[url.pathname];
    if(!file) return json(res,{error:'Not found'},404);
    const bytes=await readFile(path.join(ROOT,'public',file));
    res.writeHead(200,{'Content-Type':types[path.extname(file)],'X-Content-Type-Options':'nosniff'});res.end(bytes);
  } catch(e) { console.error(e.message);json(res,{error:e.message},502); }
});
server.requestTimeout=300000;
const flag=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
server.listen(Number(flag('--port')||process.env.PORT)||3000,flag('--host')||process.env.HOST||'127.0.0.1',()=>console.log(`F1 Replay → http://localhost:${server.address().port}`));
