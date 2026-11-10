import {configuredClient} from './connection.js';
import {MotionBuffer} from './motion-buffer.js';
const motion=new MotionBuffer();
const $=id=>document.getElementById(id), ui=Object.fromEntries([...document.querySelectorAll('[id]')].map(el=>[el.id,el]));
const ctx=ui.map.getContext('2d'),rows=new Map();
let api=null,viewId=null,state=null,geometry=null,lastSequence=0,epoch=0,streamAbort=null,queue=Promise.resolve(),markerKey='',audioURL=null,audioClip=null,audioRequest=null,lastRadioTime=null,signingIn=false;
const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
const duration=ms=>{const seconds=Math.max(0,Math.floor(ms/1000));return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;};
const gap=value=>!value?'—':value.unit==='laps'?`+${value.value} ${value.value===1?'LAP':'LAPS'}`:`+${value.value.toFixed(3)}s`;
const timeLabel=time=>state?.source==='live'?new Date(time).toISOString().slice(11,19):(time<state?.playback.start?'−':'')+duration(Math.abs(time-(state?.playback.start??time)));
const option=(value,text)=>new Option(text,value);
function status(text,error=false){ui.status.textContent=text;ui.status.classList.toggle('error',error);}
function fail(error){status(error.message,true);if(error.code==='API_UNAUTHORIZED')lock('Configured access token rejected. Check public/.env and restart the server.');}
function localStopAudio(){audioRequest?.abort();audioRequest=null;ui['radio-audio'].pause();ui['radio-audio'].removeAttribute('src');ui['radio-audio'].load();if(audioURL)URL.revokeObjectURL(audioURL);audioURL=null;audioClip=null;lastRadioTime=null;ui['radio-player'].hidden=true;}
function enabled(connected){
  for(const el of [ui.year,ui.month,ui.track,ui.race,ui.load,ui['mode-history'],ui['mode-live'],ui['show-sectors'],ui['show-turns'],ui['show-names'],ui['events-control'],ui['events-pit'],ui['events-radio'],ui['f1-login']])el.disabled=!connected;
  for(const el of [ui.play,ui.seek,ui.reset,ui.speed,ui['live-connect'],ui['live-disconnect'],ui['f1-logout']])el.disabled=true;
}
function lock(message='Connection closed. Retry to reconnect using the UI configuration.'){
  epoch++;streamAbort?.abort();motion.reset();api=null;viewId=null;state=null;geometry=null;lastSequence=0;markerKey='';signingIn=false;ui['f1-password'].value='';localStopAudio();rows.clear();ui.drivers.replaceChildren();ui['event-list'].replaceChildren();ui['turn-markers'].replaceChildren();ui['turn-directory'].replaceChildren();ui['driver-count'].textContent='00 CARS';ui['driver-detail'].textContent='Connect to the server to view a race.';ui['driver-timing'].hidden=true;ui['event-count'].textContent='';ui['race-title'].textContent='Your race awaits';ui['lap-label'].textContent='TRACK VIEW';ui.empty.hidden=false;ui.empty.querySelector('h3').textContent='Connect to your server';ui.empty.querySelector('p').textContent='The UI connects using its server configuration.';ui['api-connect'].hidden=false;enabled(false);status(message);
}
function command(path,body,method='POST'){
  const own=epoch,client=api,id=viewId;
  const work=queue.catch(()=>{}).then(async()=>{
    if(!client||own!==epoch)return;
    const result=await client.request(path.replace('{view}',id),{method,body});
    if(own===epoch&&result?.id===viewId)apply(result);
    return result;
  });
  queue=work;work.catch(error=>{if(own===epoch)fail(error);});return work;
}
const patch=body=>command('/views/{view}',body,'PATCH');
const playback=body=>command('/views/{view}/playback',body);
function authStatus(auth){
  if(!auth)return;
  ui['live-auth'].textContent=auth.signedIn?`Signed in · expires ${new Date(auth.expiresAt).toLocaleString('en-GB',{timeZone:'Europe/Zurich'})} Zurich time`:auth.message||'Sign in with your F1 account below.';
  ui['f1-logout'].disabled=!auth.signedIn&&!auth.signingIn&&!signingIn;
  ui['f1-login'].disabled=Boolean(auth.signingIn||signingIn);ui['f1-login'].textContent=auth.signingIn||signingIn?'Signing in…':'Sign in to F1';
}
async function calendar(){
  const own=epoch,client=api;if(!client)return;
  ui.load.disabled=true;ui.race.disabled=true;
  const query=new URLSearchParams({year:ui.year.value});if(ui.month.value)query.set('month',ui.month.value);if(ui.track.value)query.set('circuit',ui.track.value);
  try{
    const result=await client.request('/races?'+query);if(own!==epoch||ui.year.value!==query.get('year')||ui.month.value!==(query.get('month')||'')||ui.track.value!==(query.get('circuit')||''))return;
    const track=ui.track.value,previous=ui.race.value;ui.track.replaceChildren(option('','All circuits'),...result.circuits.map(c=>option(c.id,c.name)));ui.track.value=track;
    ui.race.replaceChildren(...result.races.map(r=>option(r.session_key,`${r.circuit_short_name} · ${new Date(r.date_start).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'})}`)));
    if(!result.races.length)ui.race.add(option('','No races match these filters'));
    else if(result.races.some(r=>String(r.session_key)===previous))ui.race.value=previous;
    else if(result.races.some(r=>r.session_key===9590))ui.race.value='9590';
    ui.race.disabled=!result.races.length;ui.load.disabled=!result.races.length||state?.status==='loading';
  }catch(error){if(own===epoch)fail(error);}
}
async function stream(own){
  let failures=0;
  while(own===epoch&&api){
    streamAbort=new AbortController();
    try{await api.stream(viewId,{onState:s=>{if(own===epoch){failures=0;apply(s);}},onCoordinates:p=>{if(own===epoch)motion.coordinates(p);},onClock:offset=>motion.setOffset(offset)},{signal:streamAbort.signal});}
    catch(error){
      if(own!==epoch||error.name==='AbortError')return;
      if(['API_UNAUTHORIZED','VIEW_NOT_FOUND'].includes(error.code)){lock(error.message);return;}
      motion.reset();failures++;status('Connection interrupted. Display paused while reconnecting…',true);localStopAudio();
      if(state){state.cars=state.cars.map(c=>({...c,location:null}));for(const el of [ui.play,ui.seek,ui.reset,ui.speed,ui.load])el.disabled=true;}
      if(failures>=5){lock('Connection attempts stopped. Reconnect to the server above.');return;}
      await new Promise(resolve=>setTimeout(resolve,Math.min(10000,1000*2**(failures-1))));
    }
  }
}
async function connect(){
  const own=++epoch;streamAbort?.abort();ui['api-connect'].disabled=true;status('Connecting…');
  try{
    const client=await configuredClient();if(own!==epoch)return;const system=await client.request('/system');if(own!==epoch)return;
    const created=await client.request('/views',{method:'POST',body:{source:'history'}});if(own!==epoch)return;
    api=client;viewId=created.id;lastSequence=0;geometry=null;ui['api-connect'].hidden=true;enabled(true);apply(created);
    ui.year.replaceChildren();for(let y=new Date(system.serverTime).getUTCFullYear();y>=2023;y--)ui.year.add(option(y,y));ui.year.value='2024';
    ui.month.replaceChildren(option('','All months'));for(let m=1;m<=12;m++)ui.month.add(option(m,new Date(2024,m-1,1).toLocaleString('en',{month:'long'})));
    await calendar();authStatus(await client.request('/f1/auth'));if(own===epoch)stream(own);
  }catch(error){if(own===epoch)lock(error.code==='API_UNAUTHORIZED'?'Configured access token rejected. Check public/.env and restart the server.':error.message);}finally{ui['api-connect'].disabled=false;}
}
ui['api-connect'].onclick=connect;
ui['f1-form'].onsubmit=async event=>{
  event.preventDefault();if(!api||signingIn)return;signingIn=true;const client=api,own=epoch,body={email:ui['f1-email'].value,password:ui['f1-password'].value};ui['f1-password'].value='';ui['f1-login'].disabled=true;ui['f1-login'].textContent='Signing in…';ui['f1-logout'].disabled=false;
  try{const auth=await client.request('/f1/auth/login',{method:'POST',body});if(own===epoch){authStatus(auth);status('Signed in to F1. Click Connect to F1 when you want live timing.');}}
  catch(error){if(own===epoch)fail(error);}finally{body.password='';if(own===epoch){signingIn=false;ui['f1-login'].disabled=false;ui['f1-login'].textContent='Sign in to F1';}}
};
ui['f1-logout'].onclick=()=>command('/f1/auth/logout',{}).then(auth=>{if(auth)authStatus(auth);}).catch(()=>{});
for(const action of ['connect','disconnect'])ui['live-'+action].onclick=()=>command('/live/'+action,{}).then(s=>{if(s){authStatus(s.auth);ui['live-status'].textContent=s.connection.message;}}).catch(()=>{});
for(const source of ['history','live'])ui['mode-'+source].onclick=()=>patch({source});
ui.year.onchange=()=>{ui.track.value='';calendar();};ui.month.onchange=calendar;ui.track.onchange=calendar;
ui.load.onclick=()=>{if(ui.race.value)patch({source:'history',raceId:+ui.race.value});};
ui.play.onclick=()=>playback({action:state?.playback.playing?'pause':'play'});ui.reset.onclick=()=>playback({action:'reset'});
ui.speed.onchange=()=>playback({action:'speed',speed:+ui.speed.value});
ui.seek.onchange=()=>{if(state?.playback.start!==null)playback({action:'seek',time:state.playback.start+(state.playback.end-state.playback.start)*+ui.seek.value/1000});};
ui['all-drivers'].onclick=()=>patch({selectedDriver:null});
for(const key of ['sectors','turns','names'])ui['show-'+key].onchange=()=>patch({overlays:{[key]:ui['show-'+key].checked}});
for(const key of ['control','pit','radio'])ui['events-'+key].onchange=()=>patch({notifications:['control','pit','radio'].filter(k=>ui['events-'+k].checked)});
ui['close-radio'].onclick=()=>command('/views/{view}/radio',{action:'stop'});
ui['radio-toggle'].onclick=()=>command('/views/{view}/radio',{action:state?.radio?.playing?'pause':'play'});
ui['radio-seek'].onchange=()=>command('/views/{view}/radio',{action:'seek',time:+ui['radio-seek'].value});
ui['radio-audio'].onended=()=>command('/views/{view}/radio',{action:'stop'});
ui['radio-audio'].ontimeupdate=()=>{ui['radio-seek'].value=ui['radio-audio'].currentTime;ui['radio-position'].textContent=duration(ui['radio-audio'].currentTime*1000);};
ui['radio-audio'].onloadedmetadata=()=>{ui['radio-seek'].max=Number.isFinite(ui['radio-audio'].duration)?ui['radio-audio'].duration:0;};
ui['radio-audio'].onerror=()=>{if(audioClip)ui['radio-title'].textContent='This radio clip could not be played.';};
async function renderAudio(radio){
  if(!radio){if(audioClip)localStopAudio();return;}
  ui['radio-player'].hidden=false;ui['radio-title'].textContent=`Team radio · ${timeLabel(radio.eventTime)}`;ui['radio-toggle'].textContent=radio.playing?'Pause clip':'Play clip';
  if(radio.clipId!==audioClip){
    localStopAudio();audioClip=radio.clipId;ui['radio-player'].hidden=false;const own=epoch,id=radio.clipId;audioRequest=new AbortController();
    try{const blob=await api.audio(id,audioRequest.signal);if(own!==epoch||id!==audioClip)return;audioURL=URL.createObjectURL(blob);ui['radio-audio'].src=audioURL;lastRadioTime=radio.time;ui['radio-audio'].currentTime=radio.time;if(state?.radio?.playing)await ui['radio-audio'].play();}
    catch(error){if(error.name!=='AbortError'&&own===epoch&&id===audioClip)ui['radio-title'].textContent='This radio clip is unavailable. Select it again to retry.';}
  }else{
    if(radio.time!==lastRadioTime){lastRadioTime=radio.time;ui['radio-audio'].currentTime=radio.time;}
    if(radio.playing&&ui['radio-audio'].paused&&audioURL)ui['radio-audio'].play().catch(()=>{});else if(!radio.playing)ui['radio-audio'].pause();
  }
}
function apply(snapshot){
  if(snapshot.id!==viewId||snapshot.sequence<=lastSequence)return;lastSequence=snapshot.sequence;if(state?.motionEpoch!==snapshot.motionEpoch){ui.map.dataset.drawnFrames='0';ui.map.dataset.distinctFrames='0';ui.map.dataset.lastDrawTime='';delete ui.map.dataset.renderTime;ui.map.dataset.buffering='true';}state=snapshot;motion.state(snapshot);
  if(Object.hasOwn(snapshot,'geometry')){geometry=snapshot.geometry;if(!geometry){markerKey='';ui['turn-markers'].replaceChildren();ui['turn-directory'].replaceChildren();}}
  const live=state.source==='live',ready=state.status==='ready',settings=state.settings;
  for(const source of ['history','live'])ui['mode-'+source].setAttribute('aria-pressed',String(state.source===source));
  ui['history-filters'].hidden=live;ui['live-controls'].hidden=!live;ui.transport.hidden=live;ui['live-clock'].hidden=!live;
  ui['source-caption'].textContent=live?'F1 subscription · direct connection':'Recorded races · OpenF1';
  const badge=document.querySelector('.mode');badge.replaceChildren(node('span','pulse'),document.createTextNode(live?'LIVE F1 MODE':'REPLAY MODE'),node('small','',live?'Direct F1 timing':'Recorded positions'));
  document.querySelector('.map-corner').firstChild.textContent=live?'F1 LIVE POSITIONS ':'POSITION REPLAY ';
  document.querySelector('.notifications-heading .eyebrow').textContent=live?'EVENT TIMES IN UTC · LIVE FEED':'AT THIS MOMENT IN THE REPLAY';
  document.querySelector('.notebook-note').textContent=live?'Includes track-wide messages for every driver. Times are UTC from the F1 feed; radio clips are a selection.':'Includes track-wide messages for every driver. Times follow the replay clock; radio clips are a selection. Click a timestamp to pause at that moment.';
  for(const key of ['sectors','turns','names'])ui['show-'+key].checked=settings.overlays[key];
  ui['show-turns'].disabled=live;ui['show-names'].disabled=live||!settings.overlays.turns;
  for(const key of ['control','pit','radio'])ui['events-'+key].checked=settings.notifications.includes(key);
  ui['sector-legend'].hidden=!settings.overlays.sectors||!geometry?.sectors.length;
  ui['turn-directory'].hidden=!settings.overlays.turns||!settings.overlays.names||!geometry?.corners.length;
  ui['race-title'].textContent=state.session?.circuit||(live?'F1 live timing':'Your race awaits');ui['race-date'].textContent=state.session?.start?new Date(state.session.start).toLocaleDateString('en-GB',{timeZone:'UTC'}).toUpperCase():live?'DIRECT F1':'SELECT A RACE';
  ui['lap-label'].textContent=`${live?'LIVE · ':''}LAP ${state.lap||'—'} / ${state.totalLaps||'—'}`;
  ui['driver-count'].textContent=`${state.cars.length} CARS`;
  ui.play.disabled=ui.seek.disabled=ui.reset.disabled=ui.speed.disabled=!ready||live;ui.play.textContent=state.playback.playing?'Ⅱ':'▶';ui.play.setAttribute('aria-label',state.playback.playing?'Pause replay':'Start replay');ui.speed.value=state.playback.speed;
  ui.load.disabled=!ui.race.value||state.status==='loading';
  if(!live&&state.playback.start!==null)ui.duration.textContent=duration(state.playback.end-state.playback.start);
  if(live){authStatus(state.auth);ui['live-status'].textContent=state.message;const active=['streaming','waiting','connecting','reconnecting','stale'].includes(state.status);ui['live-connect'].disabled=active||!state.auth?.signedIn;ui['live-disconnect'].disabled=!active;ui['live-track-status'].textContent=[state.liveStatus?.session,state.liveStatus?.track].filter(Boolean).join(' · ');}
  ui.empty.hidden=Boolean(geometry?.points.length);
  ui.empty.querySelector('h3').textContent=state.status==='loading'?'Bringing the field back together.':live?state.status==='waiting'?'Waiting for a live session.':'Waiting for live circuit data.':state.status==='error'?'Could not load this replay.':'A whole race, in your hands.';
  ui.empty.querySelector('p').textContent=state.status==='loading'?`${state.progress.completed}/${state.progress.total} cars ready. First downloads can take a few minutes.`:live?'The map needs a complete clean lap captured after connecting.':state.message;
  const selectedCorner=geometry?.corners.find(c=>c.id===settings.selectedTurn);
  ui['track-detail'].textContent=selectedCorner?`Turn ${selectedCorner.id} · ${selectedCorner.name||'Name not supplied'}${selectedCorner.sector?' · Sector '+selectedCorner.sector:''}`:geometry?.corners.length?'Select a numbered turn for details.':live?'Turn markers are not supplied by this live feed.':'Turn details unavailable for this session.';
  ui['track-source'].textContent=geometry?`Approximate session coordinates · reference car ${geometry.referenceLap.driverNumber}, lap ${geometry.referenceLap.lap}. ${geometry.sectors.length?'Sector colors follow recorded timing.':'Sector timing unavailable.'} ${geometry.corners.length?geometry.corners.length+' aligned turns · '+geometry.source+'.':''}`:'Waiting for a complete clean reference lap.';
  ui['timing-status'].textContent=live?'Direct F1 gaps · seconds or laps':'Recorded gaps · seconds or laps · follow the replay clock';
  ui['insights-status'].textContent=live?'Direct F1 feed · race control, pit transitions and radio when supplied.':Object.entries(state.availability).map(([name,v])=>`${name.replaceAll('_',' ')}: ${v.status}${v.count!==undefined?' ('+v.count+')':''}`).join(' · ');
  status(state.message,['error','auth_required','stale'].includes(state.status));renderTable();renderNotebook();renderAudio(state.radio);
}
function describe(car){return `${car.name} · Ahead: ${gap(car.timing.ahead)} · To P1: ${gap(car.timing.leader)} · ${car.timing.status}${car.timing.sampleTime!==null?' · Recorded '+new Date(car.timing.sampleTime).toISOString().slice(11,19)+' UTC':''}`;}
function renderTable(){
  const present=new Set(state.cars.map(c=>c.driverNumber));for(const [n,row]of rows)if(!present.has(n)){row.button.remove();rows.delete(n);}
  for(const [index,car]of state.cars.entries()){
    let row=rows.get(car.driverNumber);
    if(!row){const button=node('button','driver'),rank=node('span','rank'),stripe=node('span','stripe'),name=node('span','driver-name'),bold=node('b'),team=node('small'),notice=node('span','notice','●'),ahead=node('span','timing-cell ahead-cell'),leader=node('span','timing-cell leader-cell'),av=node('span','timing-value'),lv=node('span','timing-value'),tire=node('span','tire-cell'),compound=node('span','compound'),age=node('span','tire-age'),lap=node('span','lap');notice.setAttribute('aria-hidden','true');name.append(bold,notice,team);ahead.append(node('span','timing-heading','Ahead'),av);leader.append(node('span','timing-heading','To P1'),lv);tire.append(compound,age);button.append(rank,stripe,name,ahead,leader,tire,lap);button.onclick=()=>patch({selectedDriver:state.settings.selectedDriver===car.driverNumber?null:car.driverNumber});row={button,rank,stripe,bold,team,notice,av,lv,tire,compound,age,lap};rows.set(car.driverNumber,row);}
    row.button.className='driver'+(car.selected?' selected':'')+(!car.location?' missing':'');row.button.setAttribute('aria-pressed',String(car.selected));row.button.title=describe(car);row.rank.textContent=car.position??'—';row.stripe.style.background=car.color;row.bold.textContent=`${car.abbreviation}  ${car.driverNumber}`;row.team.textContent=car.teamName;row.notice.hidden=!car.hasNotification;row.av.textContent=car.timing.status==='leader'?'LEADER':gap(car.timing.ahead);row.lv.textContent=gap(car.timing.leader);row.lap.textContent=car.lap??'—';
    const style=car.tire?.compound?.toLowerCase()||'unknown',letter={soft:'S',medium:'M',hard:'H',intermediate:'I',wet:'W'}[style]||'?';row.compound.className='compound '+style;row.compound.textContent=letter;row.age.textContent=car.tire?.age==null?'—':`${car.tire.age}L`;row.tire.title=car.tire?`${car.tire.compound} · ${car.tire.age??'unknown'} completed laps`:'Tire data unavailable';
    if(ui.drivers.children[index]!==row.button)ui.drivers.insertBefore(row.button,ui.drivers.children[index]||null);
  }
}
let notebookKey='';
function renderNotebook(){
  const car=state.cars.find(c=>c.selected);ui['all-drivers'].hidden=!car;ui['notifications-title'].textContent=car?`${car.abbreviation} / Race notebook`:'Race notebook';ui['driver-detail'].textContent=car?`${car.name} · ${car.tire?.compound||'Tire unavailable'} · ${car.tire?.age??'—'} completed laps`:'Whole field · select a driver for their tires and notification history.';ui['driver-timing'].hidden=!car;if(car)ui['driver-timing'].textContent=describe(car);ui['event-count'].textContent=`${state.events.total} events`;
  const key=JSON.stringify([viewId,state.source,state.session?.key,state.settings.selectedDriver,state.settings.notifications,state.events]);if(key===notebookKey)return;notebookKey=key;
  const fragment=document.createDocumentFragment();if(!state.events.items.length)fragment.append(node('p','placeholder','No notifications in these categories at the current time.'));
  for(const event of state.events.items){const article=node('article','event '+event.kind),stamp=node('button','event-time',timeLabel(event.time));stamp.disabled=state.source==='live';stamp.onclick=()=>playback({action:'seek',time:Math.max(state.playback.start,event.time)});const content=node('div','event-content'),who=event.drivers.map(n=>state.cars.find(c=>c.driverNumber===n)?.abbreviation||'#'+n).join(' / ')||'TRACK';content.append(node('span','event-type',`${event.kind==='control'?'RACE CONTROL':event.kind==='pit'?'PIT LANE':'TEAM RADIO'} · ${who}${event.lap?' · LAP '+event.lap:''}`),node('p','',event.message));article.append(stamp,content);if(event.kind==='radio'){const listen=node('button','listen',event.clipId?'Listen':'Clip unavailable');listen.disabled=!event.clipId;listen.onclick=()=>command('/views/{view}/radio',{action:'play',clipId:event.clipId});article.append(listen);}fragment.append(article);}
  if(state.events.total>state.events.items.length)fragment.append(node('p','placeholder',`Showing the latest ${state.events.items.length} events. Select a driver to narrow the list.`));ui['event-list'].replaceChildren(fragment);
}
function stroke(points,project,color,width,close=false){ctx.beginPath();points.forEach((p,i)=>{const [x,y]=project(p[1],p[2]);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});if(close)ctx.closePath();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();}
function markers(project,w,h){
  const settings=state.settings,key=JSON.stringify([state.geometryRevision,w,h,settings.overlays,settings.selectedTurn]);if(key===markerKey)return;markerKey=key;ui['turn-markers'].replaceChildren();ui['turn-directory'].replaceChildren();if(!settings.overlays.turns)return;
  const placed=[];
  for(const corner of geometry.corners){const [x,y]=project(corner.x,corner.y),angle=corner.angle*Math.PI/180;let lx=Math.max(18,Math.min(w-18,x+Math.cos(angle)*28)),ly=Math.max(18,Math.min(h-48,y-Math.sin(angle)*28));for(let i=0;i<12&&placed.some(p=>Math.hypot(p[0]-lx,p[1]-ly)<27);i++)ly=Math.max(18,Math.min(h-48,ly+(i%2?-1:1)*(30+i*4)));placed.push([lx,ly]);const button=node('button','turn-marker'+(settings.overlays.names?' named':''),corner.id);button.style.left=lx+'px';button.style.top=ly+'px';button.title=`Turn ${corner.id} · ${corner.name||'Name not supplied'}`;button.setAttribute('aria-pressed',String(settings.selectedTurn===corner.id));button.onclick=()=>patch({selectedTurn:corner.id});if(corner.name){button.append(node('span','turn-name',corner.name));if(lx>w*.55)button.classList.add('label-left');}ui['turn-markers'].append(button);const entry=node('button','turn-entry');entry.setAttribute('aria-pressed',String(settings.selectedTurn===corner.id));entry.append(node('b','',`T${corner.id}`),node('span','',corner.name||'Name not supplied'));entry.onclick=button.onclick;ui['turn-directory'].append(entry);}
}
function draw(){
  const box=ui.map.getBoundingClientRect(),dpr=devicePixelRatio||1,w=box.width,h=box.height;if(ui.map.width!==Math.round(w*dpr)||ui.map.height!==Math.round(h*dpr)){ui.map.width=Math.round(w*dpr);ui.map.height=Math.round(h*dpr);}ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  if(state&&geometry?.points.length){const track=geometry.points,xs=track.map(p=>p[1]),ys=track.map(p=>p[2]),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys),scale=Math.min(Math.max(1,w-145)/(maxX-minX||1),Math.max(1,h-145)/(maxY-minY||1)),project=(x,y)=>[(x-(minX+maxX)/2)*scale+w/2,h/2-(y-(minY+maxY)/2)*scale];ctx.lineJoin='round';ctx.lineCap='round';stroke(track,project,'#0c1012',17,true);stroke(track,project,'#465257',11,true);if(state.settings.overlays.sectors&&geometry.sectors.length)for(const sector of geometry.sectors)stroke(sector.points,project,sector.color,8);else stroke(track,project,'#657174',1,true);markers(project,w,h);
    const [sx,sy]=project(track[0][1],track[0][2]);ctx.fillStyle='#d9e0db';ctx.fillRect(sx-3,sy-3,6,6);ctx.font='9px system-ui';ctx.fillText('S/F',sx+10,sy-10);
    for(const car of [...state.cars].sort((a,b)=>Number(a.selected)-Number(b.selected))){const location=state.source==='live'&&(!car.location||state.status!=='streaming')?null:motion.location(car.driverNumber);if(!location)continue;const [x,y]=project(location.x,location.y);ctx.globalAlpha=state.settings.selectedDriver !== null && !car.selected ? .22 : location.stale ? .45 : 1;ctx.fillStyle=car.color;ctx.strokeStyle='#101315';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,car.selected?7:5,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.font='600 9px system-ui';ctx.fillStyle='#f1f5ee';ctx.strokeStyle='#121719';ctx.lineWidth=3;ctx.strokeText(car.abbreviation,x+9,y-7);ctx.fillText(car.abbreviation,x+9,y-7);ctx.globalAlpha=1;}
  }
  if(state){const sample=motion.time();if(sample.time!==null){const t=sample.time;
    if(state.source==='history'){ui.elapsed.textContent=duration(t-state.playback.start);if(document.activeElement!==ui.seek)ui.seek.value=(t-state.playback.start)/(state.playback.end-state.playback.start)*1000;ui.clock.textContent='SESSION TIME · '+new Date(t).toISOString().slice(11,19)+' UTC';}
    else ui['live-utc'].textContent=new Date(t).toISOString().slice(11,19)+' UTC';
    ui.map.dataset.buffering=String(sample.buffering);ui.map.dataset.renderTime=String(t);ui.map.dataset.motionPackets=String(motion.receivedPackets);ui.map.dataset.drawnFrames=String(+(ui.map.dataset.drawnFrames||0)+1);if(ui.map.dataset.lastDrawTime!==String(t)){ui.map.dataset.distinctFrames=String(+(ui.map.dataset.distinctFrames||0)+1);ui.map.dataset.lastDrawTime=String(t);}
  }}
  requestAnimationFrame(draw);
}
lock('Connecting using UI configuration…');requestAnimationFrame(draw);connect();
