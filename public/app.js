import {positionAt,circuitFromLap,lapAt,upperBound} from './replay.js';
const $=id=>document.getElementById(id);
const ui=Object.fromEntries(['year','month','track','race','load','status','play','seek','speed','reset','elapsed','duration','clock','map','empty','race-title','race-date','lap-label','drivers','driver-count'].map(id=>[id,$(id)]));
let races=[], data=null, loading=false, playing=false, time=0, selected=null, generation=0, lastFrame=0, lastTable=0;
const ctx=ui.map.getContext('2d');
function status(text,error=false){ui.status.textContent=text;ui.status.classList.toggle('error',error);}
async function get(route,signal){const res=await fetch(route,{signal});const body=await res.json();if(!res.ok) throw Error(body.error||'Unable to load data');return body;}
function option(value,text){return new Option(text,value);}
function dateLabel(s){return new Date(s.date_start).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});}
for(let year=new Date().getUTCFullYear();year>=2023;year--)ui.year.add(option(year,year));
ui.year.value='2024';
for(let m=1;m<=12;m++)ui.month.add(option(m,new Date(2024,m-1,1).toLocaleString('en',{month:'long'})));
async function calendar(){
  const own=++generation;ui.load.disabled=true;ui.race.disabled=true;status('Loading race calendar…');
  try{const result=await get('/api/races?year='+ui.year.value);if(own!==generation)return;races=result;ui.track.replaceChildren(option('','All circuits'));for(const name of [...new Set(races.map(r=>r.circuit_short_name))].sort()) ui.track.add(option(name,name));filterRaces();status(races.length?'Choose a race and load the replay.':'No completed races available for this season.');}
  catch(e){if(own===generation){status(e.message,true);ui.race.replaceChildren(option('','Calendar unavailable'));}}
}
function filterRaces(){const previous=ui.race.value;const filtered=races.filter(r=>(!ui.month.value||new Date(r.date_start).getUTCMonth()+1===+ui.month.value)&&(!ui.track.value||r.circuit_short_name===ui.track.value));ui.race.replaceChildren(...filtered.map(r=>option(r.session_key,`${r.circuit_short_name} · ${dateLabel(r)}`)));if(!filtered.length)ui.race.add(option('','No races match these filters'));if(filtered.some(r=>String(r.session_key)===previous))ui.race.value=previous;else if(filtered.some(r=>r.session_key===9590))ui.race.value='9590';ui.race.disabled=!filtered.length||loading;ui.load.disabled=!filtered.length||loading;}
ui.year.addEventListener('change',calendar);ui.month.addEventListener('change',filterRaces);ui.track.addEventListener('change',filterRaces);
function setPlaying(value){playing=value;ui.play.textContent=value?'Ⅱ':'▶';ui.play.setAttribute('aria-label',value?'Pause replay':'Start replay');}
function controls(enabled){for(const el of [ui.play,ui.seek,ui.reset])el.disabled=!enabled;}
function duration(ms){let seconds=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
ui.play.onclick=()=>{if(!data)return;if(time>=data.end)time=data.start;setPlaying(!playing);};
ui.reset.onclick=()=>{if(data){setPlaying(false);time=data.start;updateHUD();renderTable();}};
ui.seek.oninput=()=>{if(data){time=data.start+(data.end-data.start)*ui.seek.value/1000;updateHUD();renderTable();}};
function updateHUD(){if(!data)return;ui.elapsed.textContent=duration(time-data.start);ui.duration.textContent=duration(data.end-data.start);ui.seek.value=(time-data.start)/(data.end-data.start)*1000;ui.clock.textContent='SESSION TIME · '+new Date(time).toISOString().slice(11,19)+' UTC';const started=data.laps.filter(l=>Date.parse(l.date_start)<=time).map(l=>l.lap_number);const lap=started.length?Math.max(...started):0;ui['lap-label'].textContent=`LAP ${lap||'—'} / ${data.totalLaps||'—'}`;}
function driverColor(driver){return /^[0-9a-f]{6}$/i.test(driver.team_colour)?'#'+driver.team_colour:'#b8c4c9';}
function renderTable(){
  if(!data)return;
  const ordered=data.drivers.map(d=>{const positionRows=data.positions.get(d.driver_number)||[];const i=upperBound(positionRows,time,r=>Date.parse(r.date))-1;return {d,pos:i>=0?positionRows[i].position:null};}).sort((a,b)=>(a.pos??99)-(b.pos??99)||a.d.driver_number-b.d.driver_number);
  const fragment=document.createDocumentFragment();
  for(const {d,pos} of ordered){const points=data.points.get(d.driver_number);const visible=points&&positionAt(points,time);const lap=lapAt(data.driverLaps.get(d.driver_number)||[],time);const row=document.createElement('button');row.className='driver'+(selected===d.driver_number?' selected':'')+(!visible?' missing':'');row.setAttribute('aria-pressed',String(selected===d.driver_number));row.title=(d.full_name||d.name_acronym)+(visible?'':' — no current position sample');
    const rank=document.createElement('span');rank.className='rank';rank.textContent=pos??'—';
    const stripe=document.createElement('span');stripe.className='stripe';stripe.style.background=driverColor(d);
    const name=document.createElement('span'),bold=document.createElement('b'),small=document.createElement('small');bold.textContent=`${d.name_acronym}  ${d.driver_number}`;small.textContent=d.team_name;name.append(bold,small);
    const lapCell=document.createElement('span');lapCell.className='lap';lapCell.textContent=lap?.lap_number??'—';row.append(rank,stripe,name,lapCell);row.onclick=()=>{selected=selected===d.driver_number?null:d.driver_number;renderTable();};fragment.append(row);
  }
  ui.drivers.replaceChildren(fragment);
}
ui.load.onclick=async()=>{
  const session=races.find(r=>r.session_key===+ui.race.value);if(!session||loading)return;
  const own=++generation;loading=true;setPlaying(false);controls(false);ui.load.disabled=true;for(const el of [ui.year,ui.month,ui.track,ui.race])el.disabled=true;
  data=null;selected=null;draw();ui.empty.hidden=false;ui.empty.querySelector('h3').textContent='Bringing the field back together.';ui.empty.querySelector('p').textContent='The first download may take a few minutes. Subsequent loads use a local cache.';
  ui['race-title'].textContent=session.circuit_short_name;ui['race-date'].textContent=dateLabel(session).toUpperCase()+' / GRAND PRIX';ui['lap-label'].textContent='LOADING';status('Loading drivers, lap timing and recorded positions…');
  try{
    const meta=await get('/api/race?session='+session.session_key);if(own!==generation)return;
    if(!meta.drivers.length)throw Error('No driver data available for this race.');
    const laps=meta.laps.filter(l=>l.date_start).sort((a,b)=>Date.parse(a.date_start)-Date.parse(b.date_start));
    const firstLaps=laps.filter(l=>l.lap_number===1);const start=firstLaps.length?Math.min(...firstLaps.map(l=>Date.parse(l.date_start))):Date.parse(session.date_start);
    const end=Math.max(start+60000,...laps.map(l=>Date.parse(l.date_start)+(l.lap_duration||0)*1000));
    const driverLaps=new Map(),positions=new Map();for(const d of meta.drivers){driverLaps.set(d.driver_number,laps.filter(l=>l.driver_number===d.driver_number));positions.set(d.driver_number,meta.positions.filter(p=>p.driver_number===d.driver_number).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date)));}
    data={session,drivers:meta.drivers.sort((a,b)=>a.driver_number-b.driver_number),laps,driverLaps,positions,start,end,totalLaps:Math.max(0,...laps.map(l=>l.lap_number)),points:new Map(),track:[]};time=start;updateHUD();renderTable();
    const failed=[];let completed=0;
    // Sequential loading keeps memory bounded and respects the free API limit.
    for(const d of data.drivers){
      status(`Loading car ${d.driver_number} · ${d.full_name} — ${completed}/${data.drivers.length} cars ready. First download can take a few minutes.`);
      try{const points=await get(`/api/trajectory?session=${session.session_key}&driver=${d.driver_number}`);if(own!==generation)return;if(!points.length)throw Error('No position samples');data.points.set(d.driver_number,points);if(!data.track.length){data.track=circuitFromLap(points,driverLaps.get(d.driver_number));if(data.track.length)ui.empty.hidden=true;}}
      catch(e){failed.push(d.driver_number);console.warn(`Car ${d.driver_number}:`,e.message);}
      completed++;ui['driver-count'].textContent=`${data.points.size}/${data.drivers.length} CARS`;renderTable();
    }
    if(!data.points.size)throw Error('No car position data was available. Try another completed race.');
    if(!data.track.length)throw Error('Could not reconstruct a complete circuit lap. Try another race.');
    controls(true);ui.empty.hidden=true;status(`${session.circuit_short_name} ready · ${data.points.size} cars · ${duration(end-start)} recorded.${failed.length?' Missing position data for cars '+failed.join(', ')+'.':''} Press play to begin.`,failed.length>0);updateHUD();renderTable();
  }catch(e){status(e.message,true);data=null;controls(false);ui.empty.hidden=false;ui.empty.querySelector('h3').textContent='Could not load this replay.';ui.empty.querySelector('p').textContent='Try loading again or choose another race.';ui['lap-label'].textContent='UNAVAILABLE';ui.drivers.replaceChildren();ui['driver-count'].textContent='00 CARS';}
  finally{loading=false;for(const el of [ui.year,ui.month,ui.track,ui.race])el.disabled=false;filterRaces();}
};
function draw(){
  const box=ui.map.getBoundingClientRect(),dpr=window.devicePixelRatio||1,w=box.width,h=box.height;
  if(ui.map.width!==Math.round(w*dpr)||ui.map.height!==Math.round(h*dpr)){ui.map.width=Math.round(w*dpr);ui.map.height=Math.round(h*dpr);}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);if(!data?.track.length)return;
  const track=data.track,xs=track.map(p=>p[1]),ys=track.map(p=>p[2]);const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);const scale=Math.min((w-125)/(maxX-minX||1),(h-115)/(maxY-minY||1));const project=(x,y)=>[(x-(minX+maxX)/2)*scale+w/2,h/2-(y-(minY+maxY)/2)*scale];
  ctx.beginPath();track.forEach((p,i)=>{const [x,y]=project(p[1],p[2]);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.closePath();ctx.lineJoin='round';ctx.lineCap='round';ctx.strokeStyle='#0c1012';ctx.lineWidth=17;ctx.stroke();ctx.strokeStyle='#3d484d';ctx.lineWidth=11;ctx.stroke();ctx.strokeStyle='#657174';ctx.lineWidth=1;ctx.stroke();
  const [sx,sy]=project(track[0][1],track[0][2]);ctx.fillStyle='#d9e0db';ctx.fillRect(sx-3,sy-3,6,6);ctx.font='8px system-ui';ctx.fillStyle='#8d9a9e';ctx.fillText('S/F',sx+9,sy-8);
  const drivers=[...data.drivers].sort((a,b)=>(a.driver_number===selected?1:0)-(b.driver_number===selected?1:0));
  for(const d of drivers){const points=data.points.get(d.driver_number);if(!points)continue;const p=positionAt(points,time);if(!p)continue;const [x,y]=project(p.x,p.y);const active=selected===null||selected===d.driver_number;ctx.globalAlpha=active?(p.stale ? .45 : 1):.22;ctx.fillStyle=driverColor(d);ctx.strokeStyle='#101315';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,selected===d.driver_number?7:5,0,Math.PI*2);ctx.fill();ctx.stroke();if(selected===d.driver_number){ctx.beginPath();ctx.arc(x,y,12,0,Math.PI*2);ctx.lineWidth=1;ctx.strokeStyle=driverColor(d);ctx.stroke();}ctx.font='600 9px system-ui';ctx.fillStyle='#f1f5ee';ctx.strokeStyle='#121719';ctx.lineWidth=3;ctx.strokeText(d.name_acronym,x+9,y-7);ctx.fillText(d.name_acronym,x+9,y-7);ctx.globalAlpha=1;}
}
function frame(now){const dt=lastFrame?Math.min(now-lastFrame,250):0;lastFrame=now;if(playing&&data){time=Math.min(data.end,time+dt*+ui.speed.value);if(time>=data.end)setPlaying(false);}draw();if(now-lastTable>250){lastTable=now;updateHUD();if(data&&!loading)renderTable();}requestAnimationFrame(frame);}
calendar();requestAnimationFrame(frame);
