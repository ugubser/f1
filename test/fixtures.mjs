// Explicit synthetic unit-test fixture. Never used by production code.
export const start=Date.parse('2024-09-01T13:00:00Z');
export const session={session_key:9590,session_name:'Race',circuit_key:39,circuit_short_name:'Test circuit',year:2024,date_start:new Date(start).toISOString(),date_end:new Date(start+7200000).toISOString()};
export const drivers=[1,2,3].map(n=>({driver_number:n,full_name:'Fixture Driver '+n,name_acronym:'DR'+n,team_name:'Fixture Team',team_colour:'abcdef'}));
export const lap={date_start:new Date(start+80000).toISOString(),lap_number:2,lap_duration:80,duration_sector_1:20,duration_sector_2:30,duration_sector_3:30,is_pit_out_lap:false};
export const points=Array.from({length:241},(_,i)=>[start+i*1000,Math.cos(i/80*2*Math.PI)*100,Math.sin(i/80*2*Math.PI)*100,0]);
export function fixtureLoad({fail=[],empty=[],calls=[]}={}){
 return async(endpoint,params)=>{calls.push([endpoint,params]);if(fail.includes(endpoint))throw Error('unit-private-upstream');if(empty.includes(endpoint))return [];
  if(endpoint==='sessions')return [session];if(endpoint==='drivers')return drivers;
  if(endpoint==='laps')return drivers.flatMap(d=>[{driver_number:d.driver_number,date_start:new Date(start).toISOString(),lap_number:1,lap_duration:80},{...lap,driver_number:d.driver_number}]);
  if(endpoint==='position')return drivers.map((d,i)=>({driver_number:d.driver_number,date:new Date(start).toISOString(),position:i+1}));
  if(endpoint==='location')return points;
  if(endpoint==='stints')return drivers.map(d=>({driver_number:d.driver_number,stint_number:1,compound:'HARD',lap_start:1,lap_end:2,tyre_age_at_start:0}));
  if(endpoint==='intervals')return drivers.map((d,i)=>({driver_number:d.driver_number,date:new Date(start+100000).toISOString(),interval:i?1.5:0,gap_to_leader:i*1.5}));
  if(endpoint==='race_control')return [{date:new Date(start+90000).toISOString(),message:'CAR 2 (DR2) INCIDENT',driver_number:2},{date:new Date(start+95000).toISOString(),message:'TRACK CLEAR'}];
  if(endpoint==='pit')return [{driver_number:2,date:new Date(start+100000).toISOString(),lane_duration:20,lap_number:2}];
  if(endpoint==='team_radio')return [{driver_number:2,date:new Date(start+99000).toISOString(),recording_url:'https://livetiming.formula1.com/static/test/clip.mp3'}];
  return [];
 };
}
export const fixtureCircuit=async()=>({source:'Fixture',referenceYear:2024,corners:[{number:1,letter:'',name:'Fixture bend',x:100,y:0,angle:0}]});
export function fakeLive(){
 let signedIn=false;const tokens={read:async()=>{if(!signedIn)throw Error('Not signed in');return {value:'private-f1-test-token',expiresAt:Date.now()+3600000};},status:async()=>({signedIn,expiresAt:signedIn?Date.now()+3600000:null}),save:async()=>{signedIn=true;},clear:async()=>{signedIn=false;}};
 let connection={state:'disconnected',message:'Disconnected'};let connects=0;
 const live={tokens,authStatus:()=>tokens.status(),snapshot:async()=>({auth:await tokens.status(),connection,session:{key:88,circuit:'Fixture live',name:'Race',start:null},cars:[],events:[],lapCount:{},sessionStatus:'Started',trackStatus:null,updatedAt:Date.now(),reference:null}),connect:async()=>{connects++;connection={state:'waiting',message:'Connected; waiting'};},disconnect:()=>{connection={state:'disconnected',message:'Disconnected'};},radio:async()=>Buffer.from('fixture-radio')};
 return {tokens,live,get connects(){return connects;}};
}
export async function ready(views,id){for(let i=0;i<100;i++){const s=await views.snapshot(id);if(s.status==='ready'||s.status==='error')return s;await new Promise(r=>setTimeout(r,2));}throw Error('Fixture did not finish loading');}
