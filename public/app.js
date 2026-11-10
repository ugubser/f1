import {positionAt,referenceLap,lapAt,upperBound,tireAt,sectorsFromLap,alignCorners,buildEvents,eventsAt,indexIntervals,timingAt,formatTiming} from './replay.js';
import {liveTimingAt} from './live.js';
const $=id=>document.getElementById(id);
const ui=Object.fromEntries(['year','month','track','race','load','status','play','seek','speed','reset','elapsed','duration','clock','map','empty','race-title','race-date','lap-label','drivers','driver-count','show-sectors','show-turns','show-names','sector-legend','turn-markers','track-detail','track-source','notifications-title','driver-detail','all-drivers','events-control','events-pit','events-radio','event-count','event-list','insights-status','radio-player','radio-title','radio-audio','close-radio'].map(id=>[id,$(id)]));
ui['turn-directory']=$('turn-directory');
ui['timing-status']=$('timing-status');ui['driver-timing']=$('driver-timing');
for(const id of ['mode-history','mode-live','source-caption','live-controls','live-status','live-auth','live-connect','live-disconnect','history-filters','transport','live-clock','live-utc','live-track-status','laps-heading'])ui[id]=$(id);
const ctx=ui.map.getContext('2d');
const sectorColors=['#74bdff','#c5a0ff','#ffb472'];
const tireStyles={SOFT:['S','soft'],MEDIUM:['M','medium'],HARD:['H','hard'],INTERMEDIATE:['I','intermediate'],WET:['W','wet']};
let races=[],data=null,loading=false,playing=false,time=0,selected=null,generation=0,lastFrame=0,lastTable=0,eventKey='',markerKey='';
let selectedTurn=null;
let mode='history',historyState=null,liveTimer=null,liveBusy=false;
const rows=new Map();
function setText(el,text){if(el.textContent!==text)el.textContent=text;}
function status(text,error=false){setText(ui.status,text);ui.status.classList.toggle('error',error);}
async function get(route){const res=await fetch(route);const body=await res.json();if(!res.ok)throw Error(body.error||'Unable to load data');return body;}
function option(value,text){return new Option(text,value);}
function dateLabel(s){return new Date(s.date_start).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});}
function node(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!=null)el.textContent=text;return el;}
for(let year=new Date().getUTCFullYear();year>=2023;year--)ui.year.add(option(year,year));
ui.year.value='2024';
for(let m=1;m<=12;m++)ui.month.add(option(m,new Date(2024,m-1,1).toLocaleString('en',{month:'long'})));
async function calendar(){
  const own=++generation;ui.load.disabled=true;ui.race.disabled=true;status('Loading race calendar…');
  try{const result=await get('/api/races?year='+ui.year.value);if(own!==generation)return;races=result;ui.track.replaceChildren(option('','All circuits'));for(const name of [...new Set(races.map(r=>r.circuit_short_name))].sort())ui.track.add(option(name,name));filterRaces();status(races.length?'Choose a race and load the replay.':'No completed races available for this season.');}
  catch(e){if(own===generation){status(e.message,true);ui.race.replaceChildren(option('','Calendar unavailable'));}}
}
function filterRaces(){const previous=ui.race.value;const filtered=races.filter(r=>(!ui.month.value||new Date(r.date_start).getUTCMonth()+1===+ui.month.value)&&(!ui.track.value||r.circuit_short_name===ui.track.value));ui.race.replaceChildren(...filtered.map(r=>option(r.session_key,`${r.circuit_short_name} · ${dateLabel(r)}`)));if(!filtered.length)ui.race.add(option('','No races match these filters'));if(filtered.some(r=>String(r.session_key)===previous))ui.race.value=previous;else if(filtered.some(r=>r.session_key===9590))ui.race.value='9590';ui.race.disabled=!filtered.length||loading;ui.load.disabled=!filtered.length||loading;}
ui.year.addEventListener('change',calendar);ui.month.addEventListener('change',filterRaces);ui.track.addEventListener('change',filterRaces);
function setPlaying(value){playing=value;ui.play.textContent=value?'Ⅱ':'▶';ui.play.setAttribute('aria-label',value?'Pause replay':'Start replay');}
function controls(enabled){for(const el of [ui.play,ui.seek,ui.reset])el.disabled=!enabled;}
function duration(ms){const seconds=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
function relativeTime(t){return data.live?new Date(t).toISOString().slice(11,19):(t<data.start?'−':'')+duration(Math.abs(t-data.start));}
function stopRadio(){ui['radio-audio'].pause();ui['radio-audio'].removeAttribute('src');ui['radio-audio'].load();ui['radio-player'].hidden=true;}
function seekTo(value){if(!data||data.live)return;stopRadio();time=Math.max(data.start,Math.min(data.end,value));setPlaying(false);updateHUD();renderTable();renderNotebook();}
ui.play.onclick=()=>{if(!data)return;if(time>=data.end)seekTo(data.start);setPlaying(!playing);};
ui.reset.onclick=()=>{if(data)seekTo(data.start);};
ui.seek.oninput=()=>{if(data)seekTo(data.start+(data.end-data.start)*ui.seek.value/1000);};
ui['close-radio'].onclick=stopRadio;
function selectDriver(number){stopRadio();selected=selected===number?null:number;renderTable();renderNotebook();}
ui['all-drivers'].onclick=()=>selectDriver(selected);
for(const kind of ['control','pit','radio'])ui['events-'+kind].onchange=()=>{stopRadio();renderNotebook();};
for(const key of ['show-sectors','show-turns','show-names'])ui[key].onchange=()=>{markerKey='';ui['show-names'].disabled=!ui['show-turns'].checked;ui['sector-legend'].hidden=!ui['show-sectors'].checked||!data?.sectors.length;ui['turn-directory'].hidden=!ui['show-turns'].checked||!ui['show-names'].checked;};
function updateHUD(){if(!data)return;if(data.live){ui['live-utc'].textContent=new Date(time).toISOString().slice(11,19)+' UTC';ui['lap-label'].textContent=`LIVE · LAP ${data.liveLap??'—'} / ${data.totalLaps||'—'}`;return;}ui.elapsed.textContent=duration(time-data.start);ui.duration.textContent=duration(data.end-data.start);ui.seek.value=(time-data.start)/(data.end-data.start)*1000;ui.clock.textContent='SESSION TIME · '+new Date(time).toISOString().slice(11,19)+' UTC';const started=data.laps.filter(l=>Date.parse(l.date_start)<=time).map(l=>l.lap_number);const lap=started.length?Math.max(...started):0;ui['lap-label'].textContent=`LAP ${lap||'—'} / ${data.totalLaps||'—'}`;}
function driverColor(driver){return /^[0-9a-f]{6}$/i.test(driver.team_colour)?'#'+driver.team_colour:'#b8c4c9';}
function tireLabel(tire){return tire?`${tire.compound.toLowerCase()} · ${tire.age??'unknown'} completed laps · stint ${tire.stint}`:'Tire data unavailable at this time';}
function makeDriverRow(driver){
  const button=node('button','driver');
  const rank=node('span','rank'),stripe=node('span','stripe'),name=node('span','driver-name'),bold=node('b','',`${driver.name_acronym}  ${driver.driver_number}`),team=node('small','',driver.team_name),notice=node('span','notice','●');
  notice.setAttribute('aria-hidden','true');bold.append(notice);name.append(bold,team);stripe.style.background=driverColor(driver);
  const tire=node('span','tire-cell'),compound=node('span','compound'),age=node('span','tire-age');tire.append(compound,age);
  const ahead=node('span','timing-cell ahead-cell'),aheadValue=node('span','timing-value','—');ahead.append(node('span','timing-heading','Ahead'),aheadValue);
  const leader=node('span','timing-cell leader-cell'),leaderValue=node('span','timing-value','—');leader.append(node('span','timing-heading','To P1'),leaderValue);
  const lap=node('span','lap');button.append(rank,stripe,name,ahead,leader,tire,lap);button.onclick=()=>selectDriver(driver.driver_number);
  return {button,rank,notice,tire,compound,age,lap,ahead,aheadValue,leader,leaderValue};
}
function timingDescription(timing,aheadName,leaderName){
  const base=timing?.status==='leader'?'Race leader · gap to P1: +0.000s':`Ahead${aheadName?' ('+aheadName+')':''}: ${formatTiming(timing?.ahead)} · To P1${leaderName?' ('+leaderName+')':''}: ${formatTiming(timing?.leader)}`;
  const note=timing?.status==='stale'?' · Timing sample is over 15 seconds old':timing?.status==='inactive'?' · No current car position sample':timing?.status==='pending'?' · Awaiting timing after a position change':timing?.status==='unavailable'?' · No current timing sample':'';
  return base+note+(timing?.sampleTime!=null?' · Recorded '+new Date(timing.sampleTime).toISOString().slice(11,19)+' UTC':'');
}
function renderTable(){
  if(!data)return;
  const present=new Set(data.drivers.map(d=>d.driver_number));
  for(const [number,row] of rows)if(!present.has(number)){row.button.remove();rows.delete(number);}
  if(selected!==null&&!present.has(selected))selected=null;
  const recent=eventsAt(data.events,time,{window:60000});
  const ordered=data.drivers.map(d=>{if(data.live){const car=data.liveCars.get(d.driver_number);return {d,pos:car.position,since:car.positionSince};}const records=data.positions.get(d.driver_number)||[];const i=upperBound(records,time,r=>Date.parse(r.date))-1,record=records[i];return {d,pos:record?.position??null,since:record?Date.parse(record.date):-Infinity};}).sort((a,b)=>(a.pos??99)-(b.pos??99)||a.d.driver_number-b.d.driver_number);
  const classified=new Map();for(const car of ordered){if(Number.isInteger(car.pos)){if(!classified.has(car.pos))classified.set(car.pos,[]);classified.get(car.pos).push(car);}}
  const unique=position=>classified.get(position)?.length===1?classified.get(position)[0]:null;
  const leader=unique(1);data.currentTimings=new Map();
  for(const [index,{d,pos,since}] of ordered.entries()){
    let row=rows.get(d.driver_number);if(!row){row=makeDriverRow(d);rows.set(d.driver_number,row);}
    const points=data.points.get(d.driver_number),visible=points&&positionAt(points,time),laps=data.driverLaps.get(d.driver_number)||[],car=data.liveCars?.get(d.driver_number),lap=data.live?null:lapAt(laps,time),tire=data.live?car.tire:tireAt(data.stints.get(d.driver_number)||[],laps,time);
    const hasNotice=recent.some(e=>!e.drivers.length||e.drivers.includes(d.driver_number));
    const ahead=unique(pos-1),context={position:unique(pos)?pos:null,positionSince:since,aheadSince:ahead?.since??null,leaderSince:leader?.since??null,raceStart:data.start,active:Boolean(visible)};
    const connected=data.live&&data.connectionState==='streaming'&&time-data.updatedAt<30000;
    const timing=data.live?liveTimingAt(car,time,{...context,connected}):timingAt(data.intervals.get(d.driver_number)||[],time,context);
    const description=timingDescription(timing,ahead?.d.name_acronym,leader?.d.name_acronym);data.currentTimings.set(d.driver_number,{...timing,description});
    row.aheadValue.textContent=timing.status==='leader'?'LEADER':formatTiming(timing.ahead);row.leaderValue.textContent=formatTiming(timing.leader);row.ahead.title=description;row.leader.title=description;
    row.ahead.classList.toggle('timing-empty',!timing.ahead&&timing.status!=='leader');row.leader.classList.toggle('timing-empty',!timing.leader);
    row.button.className='driver'+(selected===d.driver_number?' selected':'')+(!visible?' missing':'');row.button.setAttribute('aria-pressed',String(selected===d.driver_number));
    row.button.title=`${d.full_name} · ${description} · ${tireLabel(tire)}${hasNotice?' · recent notification':''}${visible?'':' · no current position sample'}`;
    row.button.setAttribute('aria-label',row.button.title);
    row.rank.textContent=pos??'—';row.lap.textContent=data.live?(car.lap??'—'):(lap?.lap_number??'—');row.notice.hidden=!hasNotice;
    const [letter,style]=tireStyles[tire?.compound]||['?','unknown'];row.compound.className='compound '+style;row.compound.textContent=letter;row.age.textContent=tire?.age==null?'—':`${tire.age}L`;row.tire.title=tireLabel(tire);
    // Preserve focused buttons and scroll position as the clock advances.
    if(ui.drivers.children[index]!==row.button)ui.drivers.insertBefore(row.button,ui.drivers.children[index]||null);
  }
}
function renderNotebook(){
  if(!data)return;
  const driver=data.drivers.find(d=>d.driver_number===selected),laps=data.driverLaps.get(selected)||[],tire=data.live?data.liveCars.get(selected)?.tire:tireAt(data.stints.get(selected)||[],laps,time);
  ui['notifications-title'].textContent=driver?`${driver.name_acronym} / Race notebook`:'Race notebook';ui['all-drivers'].hidden=selected===null;
  ui['driver-detail'].textContent=driver?`${driver.full_name} · ${tireLabel(tire)}${positionAt(data.points.get(selected)||[],time)?'':' · no current position sample'}`:'Whole field · select a driver for their tires and notification history.';
  ui['driver-timing'].hidden=!driver;ui['driver-timing'].textContent=driver?(data.currentTimings.get(selected)?.description||'Timing unavailable'):'';
  const kinds=['control','pit','radio'].filter(k=>ui['events-'+k].checked),events=eventsAt(data.events,time,{driver:selected,kinds}).reverse();
  ui['event-count'].textContent=`${events.length} events`;
  const visible=events.slice(0,80),key=JSON.stringify([selected,kinds,visible.map(e=>[e.id,e.message,e.time])]);if(key===eventKey)return;eventKey=key;
  const fragment=document.createDocumentFragment();
  if(!visible.length)fragment.append(node('p','placeholder',kinds.length?(data.live?'No notifications received in these categories yet.':'No notifications in the selected categories up to this replay time.'):'Select a notification category above.'));
  for(const event of visible){
    const item=node('article','event '+event.kind),stamp=node('button','event-time',relativeTime(event.time));stamp.title=event.time<data.start?'Pre-race event · jump to replay start':'Pause replay at this event';stamp.setAttribute('aria-label',`${stamp.title} ${relativeTime(event.time)}`);stamp.onclick=()=>seekTo(event.time);
    if(data.live){stamp.disabled=true;stamp.title='Live event time in UTC';stamp.setAttribute('aria-label',relativeTime(event.time)+' UTC');}
    const content=node('div','event-content'),who=event.drivers.map(n=>data.drivers.find(d=>d.driver_number===n)?.name_acronym||`#${n}`).join(' / ')||'TRACK';
    content.append(node('span','event-type',`${event.kind==='control'?'RACE CONTROL':event.kind==='pit'?'PIT LANE':'TEAM RADIO'} · ${who}${event.lap?' · LAP '+event.lap:''}`),node('p','',event.message));item.append(stamp,content);
    if(event.kind==='radio'){
      const listen=node('button','listen',event.url?'Listen ↗':'Clip unavailable');listen.disabled=!event.url;listen.onclick=()=>{
        stopRadio();setPlaying(false);ui['radio-player'].hidden=false;ui['radio-title'].textContent=`${who} · ${relativeTime(event.time)} · Team radio`;ui['radio-audio'].src=event.url;
        ui['radio-audio'].play().catch(()=>{ui['radio-title'].textContent=`${who} · Clip could not play. Use the audio controls to retry.`;});
      };item.append(listen);
    }
    fragment.append(item);
  }
  if(events.length>80)fragment.append(node('p','source-note','Showing the latest 80 events. Select a driver or a category to narrow the list.'));
  ui['event-list'].replaceChildren(fragment);
}
function availabilityText(insights){
  const labels={stints:'Tires',race_control:'Race control',pit:'Pit stops',team_radio:'Radio'};
  return Object.entries(labels).map(([key,label])=>{const entry=insights.availability[key];return `${label}: ${entry.status==='available'?insights[key].length+' records':entry.status==='empty'?'no records in this session':'unavailable ('+entry.message+')'}`;}).join(' · ');
}
function updateTrack(){
  if(!data)return;
  data.corners=data.circuit?alignCorners(data.track,data.circuit.corners):[];
  markerKey='';ui['sector-legend'].hidden=!ui['show-sectors'].checked||!data.sectors.length;
  const sectorNote=data.sectors.length?`Sectors from car ${data.reference.lap.driver_number}, lap ${data.reference.lap.lap_number} timing; boundaries are approximate.`:'Sector timing unavailable for the reference lap; sectors are not colored.';
  let cornerNote=data.circuitError||'Turn metadata loading…';
  if(data.circuit){cornerNote=data.corners.length?`${data.corners.length} turns · MultiViewer markers (reference ${data.circuit.referenceYear}); checked against this session’s lap.`:data.circuit.corners.length?'Turn markers do not align with this session; turn overlay unavailable.':'No turn markers for this track.';}
  ui['track-source'].replaceChildren(document.createTextNode(`${sectorNote} ${cornerNote}`));
  if(data.circuit){const link=node('a','', ' MultiViewer ↗');link.href='https://multiviewer.app/';link.target='_blank';link.rel='noreferrer';ui['track-source'].append(link);}
  if(data.circuit?.nameSource){const link=node('a','',' Turn names ↗');link.href=data.circuit.nameSource;link.target='_blank';link.rel='noreferrer';ui['track-source'].append(link);}
  ui['track-detail'].textContent=data.corners.length?'Select a numbered turn for its name and sector.':'Turn details unavailable for this session.';
}
ui.load.onclick=async()=>{
  const session=races.find(r=>r.session_key===+ui.race.value);if(!session||loading)return;
  const own=++generation;loading=true;setPlaying(false);stopRadio();controls(false);ui.load.disabled=true;for(const el of [ui.year,ui.month,ui.track,ui.race])el.disabled=true;
  ui['mode-live'].disabled=true;
  data=null;selected=null;selectedTurn=null;rows.clear();eventKey='';markerKey='';ui.drivers.replaceChildren();ui['turn-markers'].replaceChildren();ui['turn-directory'].replaceChildren();ui['event-list'].replaceChildren(node('p','placeholder','Loading notification sources…'));ui['insights-status'].textContent='Checking tires, race control, pit stops and radio…';ui['driver-detail'].textContent='Select a driver to follow their tires and notifications.';ui['notifications-title'].textContent='Race notebook';ui['event-count'].textContent='';ui['all-drivers'].hidden=true;ui['driver-count'].textContent='00 CARS';ui['track-source'].textContent='Checking sector timing and turn markers…';ui['track-detail'].textContent='Loading track details…';ui['sector-legend'].hidden=true;
  ui['timing-status'].textContent='Loading race gaps…';ui['driver-timing'].hidden=true;
  draw();ui.empty.hidden=false;ui.empty.querySelector('h3').textContent='Bringing the field back together.';ui.empty.querySelector('p').textContent='The first download may take a few minutes. Subsequent loads use a local cache.';
  ui['race-title'].textContent=session.circuit_short_name;ui['race-date'].textContent=dateLabel(session).toUpperCase()+' / GRAND PRIX';ui['lap-label'].textContent='LOADING';status('Loading drivers, lap timing and recorded positions…');
  try{
    const meta=await get('/api/race?session='+session.session_key);if(own!==generation)return;
    if(!meta.drivers.length)throw Error('No driver data available for this race.');
    const laps=meta.laps.filter(l=>l.date_start).sort((a,b)=>Date.parse(a.date_start)-Date.parse(b.date_start));
    const firstLaps=laps.filter(l=>l.lap_number===1),start=firstLaps.length?Math.min(...firstLaps.map(l=>Date.parse(l.date_start))):Date.parse(session.date_start);
    const end=Math.max(start+60000,...laps.map(l=>Date.parse(l.date_start)+(l.lap_duration||0)*1000));
    const driverLaps=new Map(),positions=new Map();for(const d of meta.drivers){driverLaps.set(d.driver_number,laps.filter(l=>l.driver_number===d.driver_number));positions.set(d.driver_number,meta.positions.filter(p=>p.driver_number===d.driver_number).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date)));}
    data={session,drivers:meta.drivers.sort((a,b)=>a.driver_number-b.driver_number),laps,driverLaps,positions,start,end,totalLaps:Math.max(0,...laps.map(l=>l.lap_number)),points:new Map(),track:[],sectors:[],corners:[],circuit:null,stints:new Map(),events:[],intervals:new Map(),currentTimings:new Map()};
    const current=data;time=start;updateHUD();renderTable();renderNotebook();
    const insightsTask=get('/api/insights?session='+session.session_key).then(insights=>{
      if(own!==generation||data!==current)return;
      for(const driver of data.drivers)data.stints.set(driver.driver_number,insights.stints.filter(s=>s.driver_number===driver.driver_number));
      data.events=buildEvents(insights);ui['insights-status'].textContent=availabilityText(insights);renderTable();renderNotebook();
    }).catch(e=>{if(own===generation&&data===current)ui['insights-status'].textContent='Notification and tire sources unavailable: '+e.message;});
    const circuitTask=get('/api/circuit?session='+session.session_key).then(circuit=>{if(own===generation&&data===current){data.circuit=circuit;updateTrack();}}).catch(e=>{if(own===generation&&data===current){data.circuitError='Turn markers unavailable: '+e.message;updateTrack();}});
    const timingTask=get('/api/timing?session='+session.session_key).then(timing=>{
      if(own!==generation||data!==current)return;
      data.intervals=indexIntervals(timing.intervals);ui['timing-status'].textContent=timing.availability.status==='empty'?'No race timing records for this session.':'Recorded gaps · seconds or laps · follow the replay clock';renderTable();renderNotebook();
    }).catch(e=>{if(own===generation&&data===current)ui['timing-status'].textContent='Race gaps unavailable: '+e.message;});
    const failed=[];let completed=0;
    // Sequential car loading bounds memory and respects the free API limit.
    for(const d of data.drivers){
      status(`Loading car ${d.driver_number} · ${d.full_name} — ${completed}/${data.drivers.length} cars ready. First download can take a few minutes.`);
      try{
        const points=await get(`/api/trajectory?session=${session.session_key}&driver=${d.driver_number}`);if(own!==generation)return;if(!points.length)throw Error('No position samples');data.points.set(d.driver_number,points);
        if(!data.track.length){const ref=referenceLap(points,driverLaps.get(d.driver_number));if(ref){data.reference=ref;data.track=ref.points;data.sectors=sectorsFromLap(ref.points,ref.lap);updateTrack();ui.empty.hidden=true;}}
      }catch(e){failed.push(d.driver_number);console.warn(`Car ${d.driver_number}:`,e.message);}
      completed++;ui['driver-count'].textContent=`${data.points.size}/${data.drivers.length} CARS`;renderTable();
    }
    await Promise.all([insightsTask,circuitTask,timingTask]);
    if(!data.points.size)throw Error('No car position data was available. Try another completed race.');
    if(!data.track.length)throw Error('Could not reconstruct a complete circuit lap. Try another race.');
    controls(true);ui.empty.hidden=true;status(`${session.circuit_short_name} ready · ${data.points.size} cars · ${duration(end-start)} recorded.${failed.length?' Missing position data for cars '+failed.join(', ')+'.':''} Press play to begin.`,failed.length>0);updateHUD();renderTable();renderNotebook();
  }catch(e){status(e.message,true);data=null;stopRadio();controls(false);ui.empty.hidden=false;ui.empty.querySelector('h3').textContent='Could not load this replay.';ui.empty.querySelector('p').textContent='Try loading again or choose another race.';ui['lap-label'].textContent='UNAVAILABLE';ui.drivers.replaceChildren();ui['turn-markers'].replaceChildren();ui['turn-directory'].replaceChildren();ui['event-list'].replaceChildren();ui['driver-count'].textContent='00 CARS';ui['track-source'].textContent='Track details unavailable.';ui['track-detail'].textContent='';ui['insights-status'].textContent='Replay unavailable; load a race to view notifications.';ui['timing-status'].textContent='Race gaps unavailable.';ui['driver-timing'].hidden=true;}
  finally{loading=false;ui['mode-live'].disabled=false;for(const el of [ui.year,ui.month,ui.track,ui.race])el.disabled=false;filterRaces();}
};
function strokePath(points,project,color,width,close=false){ctx.beginPath();points.forEach((p,i)=>{const [x,y]=project(p[1],p[2]);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});if(close)ctx.closePath();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
function turnDetail(corner){
  selectedTurn=corner.number+corner.letter;
  for(const parent of [ui['turn-markers'],ui['turn-directory']])for(const button of parent.children)button.setAttribute('aria-pressed',String(button.dataset.turn===selectedTurn));
  const closest=data.track.reduce((a,p)=>Math.hypot(p[1]-corner.x,p[2]-corner.y)<Math.hypot(a[1]-corner.x,a[2]-corner.y)?p:a,data.track[0]);
  const sector=data.sectors.find(s=>closest[0]>=s.points[0][0]&&closest[0]<=s.points.at(-1)[0]);
  ui['track-detail'].textContent=`Turn ${selectedTurn} · ${corner.name||'Name not supplied'}${sector?' · Sector '+sector.number:''} · Approximate marker`;
}
function renderMarkers(project,w,h){
  const key=[generation,w,h,data.corners.length,ui['show-turns'].checked,ui['show-names'].checked].join('/');if(markerKey===key)return;markerKey=key;
  ui['turn-markers'].replaceChildren();ui['turn-directory'].replaceChildren();data.markerLines=[];if(!ui['show-turns'].checked)return;
  const placed=[];
  for(const corner of data.corners){
    const [x,y]=project(corner.x,corner.y),r=corner.angle*Math.PI/180;
    let lx=Math.max(18,Math.min(w-18,x+Math.cos(r)*28)),ly=Math.max(18,Math.min(h-48,y-Math.sin(r)*28));
    for(let attempt=0;attempt<12&&placed.some(p=>Math.hypot(p[0]-lx,p[1]-ly)<27);attempt++)ly=Math.max(18,Math.min(h-48,ly+(attempt%2?-1:1)*(30+attempt*4)));
    placed.push([lx,ly]);
    data.markerLines.push([[x,y],[lx,ly]]);
    const button=node('button','turn-marker',corner.number+corner.letter);button.dataset.turn=corner.number+corner.letter;button.setAttribute('aria-pressed',String(button.dataset.turn===selectedTurn));button.style.left=lx+'px';button.style.top=ly+'px';
    button.style.setProperty('--marker-x',(x-lx)+'px');button.style.setProperty('--marker-y',(y-ly)+'px');
    button.title=`Turn ${corner.number}${corner.letter} · ${corner.name||'Name not supplied'}`;button.setAttribute('aria-label',button.title);button.onclick=()=>turnDetail(corner);
    if(corner.name){const name=node('span','turn-name',corner.name);if(lx>w*.55)button.classList.add('label-left');button.append(name);}
    ui['turn-markers'].append(button);
    const entry=node('button','turn-entry');entry.dataset.turn=corner.number+corner.letter;entry.setAttribute('aria-pressed',String(entry.dataset.turn===selectedTurn));entry.append(node('b','',`T${corner.number}${corner.letter}`),node('span','',corner.name||'Name not supplied'));entry.onclick=()=>turnDetail(corner);ui['turn-directory'].append(entry);
  }
}
function draw(){
  const box=ui.map.getBoundingClientRect(),dpr=window.devicePixelRatio||1,w=box.width,h=box.height;
  if(ui.map.width!==Math.round(w*dpr)||ui.map.height!==Math.round(h*dpr)){ui.map.width=Math.round(w*dpr);ui.map.height=Math.round(h*dpr);}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);if(!data?.track.length)return;
  const track=data.track,xs=track.map(p=>p[1]),ys=track.map(p=>p[2]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const scale=Math.min(Math.max(1,w-145)/(maxX-minX||1),Math.max(1,h-145)/(maxY-minY||1)),project=(x,y)=>[(x-(minX+maxX)/2)*scale+w/2,h/2-(y-(minY+maxY)/2)*scale];
  ctx.lineJoin='round';ctx.lineCap='round';strokePath(track,project,'#0c1012',17,true);strokePath(track,project,'#465257',11,true);
  if(ui['show-sectors'].checked&&data.sectors.length){for(const sector of data.sectors)strokePath(sector.points,project,sectorColors[sector.number-1],8);strokePath([track.at(-1),track[0]],project,sectorColors[2],8);}
  else strokePath(track,project,'#657174',1,true);
  if(ui['show-turns'].checked)for(const corner of data.corners){const [x,y]=project(corner.x,corner.y);ctx.beginPath();ctx.arc(x,y,2,0,Math.PI*2);ctx.fillStyle='#eef2ee';ctx.fill();}
  renderMarkers(project,w,h);
  if(ui['show-turns'].checked)for(const [a,b] of data.markerLines||[]){ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.strokeStyle='#82939b66';ctx.lineWidth=1;ctx.stroke();}
  const [sx,sy]=project(track[0][1],track[0][2]);ctx.fillStyle='#d9e0db';ctx.fillRect(sx-3,sy-3,6,6);ctx.font='9px system-ui';ctx.fillStyle='#b6c1c5';ctx.fillText('S/F',sx+10,sy-10);
  const drivers=[...data.drivers].sort((a,b)=>(a.driver_number===selected?1:0)-(b.driver_number===selected?1:0));
  for(const d of drivers){const points=data.points.get(d.driver_number);if(!points)continue;const p=positionAt(points,time);if(!p)continue;const [x,y]=project(p.x,p.y),active=selected===null||selected===d.driver_number;ctx.globalAlpha=active?(p.stale ? .45 : 1):.22;ctx.fillStyle=driverColor(d);ctx.strokeStyle='#101315';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,selected===d.driver_number?7:5,0,Math.PI*2);ctx.fill();ctx.stroke();if(selected===d.driver_number){ctx.beginPath();ctx.arc(x,y,12,0,Math.PI*2);ctx.lineWidth=1;ctx.strokeStyle=driverColor(d);ctx.stroke();}ctx.font='600 9px system-ui';ctx.fillStyle='#f1f5ee';ctx.strokeStyle='#121719';ctx.lineWidth=3;ctx.strokeText(d.name_acronym,x+9,y-7);ctx.fillText(d.name_acronym,x+9,y-7);ctx.globalAlpha=1;}
}
function frame(now){const dt=lastFrame?Math.min(now-lastFrame,250):0;lastFrame=now;if(data?.live)time=Date.now();else if(playing&&data){time=Math.min(data.end,time+dt*+ui.speed.value);if(time>=data.end)setPlaying(false);}draw();if(now-lastTable>250){lastTable=now;updateHUD();if(data&&!loading){renderTable();renderNotebook();}}requestAnimationFrame(frame);}
ui['radio-audio'].addEventListener('error',()=>{if(!ui['radio-player'].hidden)ui['radio-title'].textContent='This radio clip is unavailable from the source.';});
async function liveRequest(action){
  const response=await fetch('/api/live/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-F1-Action':'1'},body:'{}'});
  const body=await response.json();if(!response.ok)throw Error(body.error||'The live request failed.');return body;
}
function clearPanels(){
  rows.clear();eventKey='';markerKey='';selectedTurn=null;ui.drivers.replaceChildren();ui['turn-markers'].replaceChildren();ui['turn-directory'].replaceChildren();ui['driver-count'].textContent='00 CARS';ui['driver-timing'].hidden=true;ui['event-count'].textContent='';ui['all-drivers'].hidden=true;ui['sector-legend'].hidden=true;ui['event-list'].replaceChildren(node('p','placeholder','Waiting for session data…'));ui.empty.hidden=false;
}
async function setMode(next){
  if(next===mode||loading||liveBusy)return;
  clearTimeout(liveTimer);generation++;setPlaying(false);stopRadio();
  if(mode==='history')historyState={data,time,selected,status:ui.status.textContent,insights:ui['insights-status'].textContent,timing:ui['timing-status'].textContent};
  else liveRequest('disconnect').catch(()=>{if(mode==='history')status('Historical replay is available. Could not confirm the live disconnect.',true);});
  mode=next;data=null;selected=null;clearPanels();controls(false);
  ui['mode-history'].setAttribute('aria-pressed',String(mode==='history'));ui['mode-live'].setAttribute('aria-pressed',String(mode==='live'));
  ui['live-controls'].hidden=mode!=='live';ui['history-filters'].hidden=mode==='live';ui.transport.hidden=mode==='live';ui['live-clock'].hidden=mode!=='live';ui['laps-heading'].textContent=mode==='live'?'LAPS':'LAP';
  ui['show-turns'].disabled=mode==='live';ui['show-names'].disabled=mode==='live'||!ui['show-turns'].checked;
  ui['source-caption'].textContent=mode==='live'?'F1 subscription · direct connection':'Recorded races · OpenF1';
  document.querySelector('.map-corner').firstChild.textContent=mode==='live'?'F1 LIVE POSITIONS ':'POSITION REPLAY ';
  document.querySelector('.notifications-heading .eyebrow').textContent=mode==='live'?'EVENT TIMES IN UTC · LIVE FEED':'AT THIS MOMENT IN THE REPLAY';
  document.querySelector('.notebook-note').textContent=mode==='live'?'Includes track-wide messages for every driver. Times are UTC from the F1 feed; radio clips are a selection.':'Includes track-wide messages for every driver. Times follow the source feed; radio clips are a selection. Click a timestamp to pause at that moment.';
  const badge=document.querySelector('.mode');badge.replaceChildren(node('span','pulse'),document.createTextNode(mode==='live'?'LIVE F1 MODE':'REPLAY MODE'),node('small','',mode==='live'?'Direct F1 timing · subscription required':'Recorded positions · no live feed'));
  if(mode==='live'){
    ui['race-title'].textContent='F1 live timing';ui['race-date'].textContent='DIRECT CONNECTION';ui['track-detail'].textContent='The circuit appears after a complete clean lap is captured.';ui['track-source'].textContent='Live coordinates and lap timing come directly from F1.';
    ui.empty.querySelector('h3').textContent='Sign in to follow F1 live.';ui.empty.querySelector('p').textContent='Open the secure sign-in instructions above, then connect to F1.';
    status('Live mode selected. Checking your local F1 sign-in…');pollLive();
  }else{
    if(historyState?.data){
      ({data,time,selected}=historyState);ui.empty.hidden=Boolean(data.track.length);ui['race-title'].textContent=data.session.circuit_short_name;ui['race-date'].textContent=dateLabel(data.session).toUpperCase()+' / GRAND PRIX';ui['driver-count'].textContent=`${data.points.size}/${data.drivers.length} CARS`;ui['insights-status'].textContent=historyState.insights;ui['timing-status'].textContent=historyState.timing;status(historyState.status);controls(Boolean(data.track.length));updateTrack();updateHUD();renderTable();renderNotebook();
    }else{
      ui['race-title'].textContent='Your race awaits';ui['race-date'].textContent='SELECT A RACE';ui['lap-label'].textContent='TRACK VIEW';ui.empty.querySelector('h3').textContent='A whole race, in your hands.';ui.empty.querySelector('p').textContent='Select a race above and load its recorded positions.';ui['track-detail'].textContent='Select a numbered turn for its details.';ui['track-source'].textContent='Sector and turn availability will appear after loading.';ui['insights-status'].textContent='Load a race to check available sources.';ui['timing-status'].textContent='Load a race to view gaps.';status('Choose a race and load the replay.');
    }
    if(races.length)filterRaces();else calendar();
  }
}
function applyLive(snapshot){
  if(mode!=='live')return;
  const active=['connecting','reconnecting','streaming','waiting','stale'].includes(snapshot.connection.state);
  setText(ui['live-status'],snapshot.connection.message);ui['live-auth'].textContent=snapshot.auth.signedIn?'Signed in locally · expires '+new Date(snapshot.auth.expiresAt).toLocaleString('en-GB',{timeZone:'Europe/Zurich'})+' Zurich time':snapshot.auth.message||'Run npm run f1:login in your own terminal.';
  ui['live-connect'].disabled=liveBusy||active||!snapshot.auth.signedIn;ui['live-disconnect'].disabled=liveBusy||!active;
  const key=snapshot.session.key;
  if(!data?.live||data.session.session_key!==key){
    selected=null;clearPanels();data={live:true,session:{session_key:key},drivers:[],driverLaps:new Map(),positions:new Map(),stints:new Map(),intervals:new Map(),currentTimings:new Map(),points:new Map(),liveCars:new Map(),track:[],sectors:[],corners:[],events:[],laps:[],referenceKey:null};
  }
  data.connectionState=snapshot.connection.state;data.updatedAt=snapshot.updatedAt;data.drivers=snapshot.cars;data.liveCars=new Map(snapshot.cars.map(c=>[c.driver_number,c]));data.points=new Map(snapshot.cars.map(c=>[c.driver_number,snapshot.connection.state==='streaming'&&!c.retired&&!c.stopped?c.points:[]]));data.events=snapshot.events;data.liveLap=snapshot.lapCount.CurrentLap??null;data.totalLaps=snapshot.lapCount.TotalLaps??null;data.session.circuit_short_name=snapshot.session.circuit;data.start=0;data.end=Date.now();time=Date.now();
  const reference=snapshot.reference,refKey=reference?`${key}/${reference.lap.driver_number}/${reference.lap.lap_number}`:null;
  data.track=reference?.points||[];data.sectors=reference?.sectors||[];data.reference=reference;
  if(data.referenceKey!==refKey){data.referenceKey=refKey;markerKey='';}
  ui['race-title'].textContent=snapshot.session.circuit||'F1 live timing';ui['race-date'].textContent=(snapshot.session.name||'NO ACTIVE SESSION').toUpperCase()+' / F1 DIRECT';ui['driver-count'].textContent=`${snapshot.cars.length} CARS`;
  ui['live-track-status'].textContent=[snapshot.sessionStatus,snapshot.trackStatus].filter(Boolean).join(' · ');
  ui.empty.hidden=Boolean(data.track.length);
  const streaming=snapshot.connection.state==='streaming',waiting=snapshot.connection.state==='waiting';
  ui.empty.querySelector('h3').textContent=streaming?'Building the live circuit.':waiting?'Waiting for a live session.':active?'Connecting to F1…':'Sign in and connect to F1.';
  ui.empty.querySelector('p').textContent=streaming?'Driver timing can appear now. The map needs one complete clean lap captured after joining.':waiting?'Connected to F1. Timing and map positions will update when a session starts.':active?'The live map will build once F1 sends a complete clean lap.':'Use the secure sign-in instructions above. Historical replay remains available.';
  setText(ui['track-detail'],reference?`Live reference: car ${reference.lap.driver_number}, lap ${reference.lap.lap_number}.`:'Waiting for a complete clean lap in this live session.');
  ui['track-source'].textContent='Direct F1 telemetry. Lap boundaries are observed and approximate. '+(data.sectors.length?'Sector colors use that lap’s recorded sector durations.':'Sector timing is not available for the reference yet.')+' Turn markers are not supplied by this live feed.';
  ui['sector-legend'].hidden=!ui['show-sectors'].checked||!data.sectors.length;
  setText(ui['timing-status'],snapshot.connection.state==='streaming'?'F1 live gaps · seconds or laps · rows show completed laps':'Waiting for current F1 timing.');
  ui['insights-status'].textContent='Direct F1 feed · race control, pit transitions and radio when supplied.';
  status(snapshot.connection.message,['error','auth_required','stale'].includes(snapshot.connection.state));updateHUD();renderTable();renderNotebook();
}
async function pollLive(){
  if(mode!=='live')return;const own=generation;
  try{const snapshot=await get('/api/live');if(mode==='live'&&own===generation)applyLive(snapshot);}
  catch(error){if(mode==='live'&&own===generation){if(data?.live)data.connectionState='error';ui['live-status'].textContent=error.message;ui['live-connect'].disabled=true;status(error.message,true);}}
  finally{if(mode==='live'&&own===generation)liveTimer=setTimeout(pollLive,1000);}
}
for(const [id,next] of [['mode-history','history'],['mode-live','live']])ui[id].onclick=()=>setMode(next);
for(const action of ['connect','disconnect'])ui['live-'+action].onclick=async()=>{
  if(liveBusy)return;liveBusy=true;ui['live-connect'].disabled=true;ui['live-disconnect'].disabled=true;ui['mode-history'].disabled=true;
  try{const snapshot=await liveRequest(action);if(mode==='live')applyLive(snapshot);}
  catch(error){ui['live-status'].textContent=error.message;status(error.message,true);}
  finally{liveBusy=false;ui['mode-history'].disabled=false;}
};
calendar();requestAnimationFrame(frame);
