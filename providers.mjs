import {readFile, writeFile, mkdir, stat} from 'node:fs/promises';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {compactLocations} from './domain/replay.mjs';
import {cornerNames} from './track-names.mjs';
const ROOT=fileURLToPath(new URL('.',import.meta.url));
const CACHE=path.join(ROOT,'.cache');
await mkdir(CACHE,{recursive:true});
let tail=Promise.resolve();
const inflight=new Map();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
// One outgoing request at a time, below the free API's per-second limit.
export function upstream(endpoint,params) {
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
export async function circuitMetadata(session) {
  const sessions=await upstream('sessions',{session_key:session}),race=sessions[0];
  if(!race)throw new Error('Session metadata is unavailable.');
  const filename=path.join(CACHE,`circuit-${race.circuit_key}-${race.year}.json.gz`);
  let source;
  try{source=JSON.parse(gunzipSync(await readFile(filename)));}catch{}
  if(!source){
    const response=await fetch(`https://api.multiviewer.app/api/v1/circuits/${race.circuit_key}/${race.year}`,{signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error(`Turn markers unavailable: circuit provider returned ${response.status}.`);
    source=await response.json();
    if(source.circuitKey!==race.circuit_key||!Array.isArray(source.corners))throw new Error('Unexpected circuit metadata.');
    if(source.corners.length)await writeFile(filename,gzipSync(JSON.stringify(source)));
  }
  const names=cornerNames[race.circuit_key];
  return {source:'MultiViewer',sourceUrl:'https://multiviewer.app/',referenceYear:source.year,requestedYear:race.year,
    nameSource:names?.source||null,corners:source.corners.map(c=>({number:c.number,letter:c.letter||'',x:c.trackPosition?.x,y:c.trackPosition?.y,angle:c.angle??0,name:c.name||names?.turns[c.number]||null}))};
}
