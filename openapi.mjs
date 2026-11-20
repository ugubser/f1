const ref = name => ({$ref:'#/components/schemas/'+name});
const nullable = type => ({type:[type,'null']});
const object = (properties, required=Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
const array = items => ({type:'array',items});
const schemas = {
  Error: object({error:object({code:{type:'string'},message:{type:'string'}})}),
  Empty: object({}),
  Login: object({email:{type:'string',minLength:1,maxLength:320},password:{type:'string',format:'password',writeOnly:true,minLength:1,maxLength:4096}}),
  Auth: object({signedIn:{type:'boolean'},expiresAt:nullable('number'),signingIn:{type:'boolean'},message:{type:'string'}},['signedIn']),
  Source: {type:'string',enum:['history','live']},
  Overlays: object({sectors:{type:'boolean'},turns:{type:'boolean'},names:{type:'boolean'}},[]),
  Vector3: {...object({x:{type:'number',minimum:-1e7,maximum:1e7},y:{type:'number',minimum:-1e7,maximum:1e7},z:{type:'number',minimum:-1e7,maximum:1e7}}),description:'Session coordinate units (about 0.1 m, approximate).'},
  CameraMode: {type:'string',enum:['orbit','birdseye','onboard','chase','trackside','director']},
  Camera: object({id:{type:'string',pattern:'^[a-z0-9-]{1,16}$'},mode:ref('CameraMode'),driver:{type:['integer','null'],minimum:1,maximum:999,description:'Target car; null follows settings.selectedDriver, else the P1 car'},position:{oneOf:[ref('Vector3'),{type:'null'}],description:'Camera eye; required for trackside, optional for orbit'},target:{oneOf:[ref('Vector3'),{type:'null'}],description:'Fixed look-at for orbit/trackside; null aims at the target car'},fov:{type:'number',minimum:15,maximum:110,description:'Vertical degrees'},hud:{type:'boolean'}}),
  CameraPatch: {...object({id:{type:'string',pattern:'^[a-z0-9-]{1,16}$'},mode:ref('CameraMode'),driver:{type:['integer','null'],minimum:1,maximum:999},position:{oneOf:[ref('Vector3'),{type:'null'}]},target:{oneOf:[ref('Vector3'),{type:'null'}]},fov:{type:'number',minimum:15,maximum:110,default:55},hud:{type:'boolean',default:true}},['id','mode']),description:'Omitted driver/position/target default to null, fov to 55, hud to true. Trackside requires position.'},
  ViewCreate: object({source:ref('Source'),raceId:{type:'integer',minimum:1}},['source']),
  ViewPatch: object({source:ref('Source'),raceId:{type:'integer',minimum:1},selectedDriver:nullable('integer'),selectedTurn:nullable('string'),notifications:array({type:'string',enum:['control','pit','radio']}),overlays:ref('Overlays'),cameras:{...array(ref('CameraPatch')),maxItems:4,description:'Replaces the whole camera list; ids must be unique'}},[]),
  PlaybackCommand: {oneOf:[object({action:{const:'play'}}),object({action:{const:'pause'}}),object({action:{const:'reset'}}),object({action:{const:'seek'},time:{type:'number',description:'UTC milliseconds within the race'}}),object({action:{const:'speed'},speed:{type:'integer',enum:[1,5,10,30,60]}})]},
  RadioCommand: object({action:{enum:['play','pause','stop','seek']},clipId:{type:'string'},time:{type:'number',minimum:0}},['action']),
  Gap: {oneOf:[object({unit:{enum:['seconds','laps']},value:{type:'number',minimum:0}}),{type:'null'}]},
  Timing: object({ahead:ref('Gap'),leader:ref('Gap'),sampleTime:nullable('number'),status:{enum:['leader','recorded','unavailable','inactive','pending','stale']},aheadDriver:nullable('integer'),leaderDriver:nullable('integer')}),
  Tire: {oneOf:[object({compound:{type:'string'},age:nullable('integer'),stint:nullable('integer')}),{type:'null'}]},
  Location: {oneOf:[object({x:{type:'number'},y:{type:'number'},stale:{type:'boolean'}}),{type:'null'}]},
  Car: object({driverNumber:{type:'integer'},name:{type:'string'},abbreviation:{type:'string'},teamName:{type:'string'},color:{type:'string'},position:nullable('integer'),lap:nullable('integer'),tire:ref('Tire'),location:ref('Location'),timing:ref('Timing'),selected:{type:'boolean'},hasNotification:{type:'boolean'}}),
  Event: object({id:{type:'string'},time:{type:'number'},kind:{enum:['control','pit','radio']},drivers:array({type:'integer'}),message:{type:'string'},lap:nullable('integer'),clipId:nullable('string')},['id','time','kind','drivers','message','clipId']),
  Events: object({total:{type:'integer'},items:array(ref('Event')),offset:{type:'integer'}},['total','items']),
  Point: {type:'array',prefixItems:[{type:'number',description:'UTC milliseconds'},{type:'number',description:'x'},{type:'number',description:'y'},{type:'number',description:'z'}],minItems:3,maxItems:4},
  Point3: {type:'array',prefixItems:[{type:'number',description:'x'},{type:'number',description:'y'},{type:'number',description:'z'}],minItems:3,maxItems:3},
  PitLane: {oneOf:[object({points:array(ref('Point3')),driverNumber:{type:'integer'},lap:nullable('integer'),entryTime:{type:'number',description:'Pit record time, UTC milliseconds'}}),{type:'null'}],description:'Recorded pit-stop trace of this session joined to the track at both ends; null when no stop qualifies.'},
  Scale: object({metresPerUnit:{type:'number'},approximate:{const:true}}),
  Sector: object({number:{type:'integer'},duration:{type:'number'},color:{type:'string'},points:array(ref('Point'))}),
  Corner: {type:'object',properties:{id:{type:'string'},number:{type:'integer'},letter:{type:'string'},name:nullable('string'),x:{type:'number'},y:{type:'number'},angle:{type:'number'},sector:nullable('integer')},required:['id','number','x','y','sector']},
  Geometry: {oneOf:[object({points:array(ref('Point')),sectors:array(ref('Sector')),corners:array(ref('Corner')),referenceLap:object({driverNumber:{type:'integer'},lap:{type:'integer'}}),pitLane:ref('PitLane'),scale:ref('Scale'),coordinateSystem:{const:'session-xy'},approximate:{const:true},source:{type:'string'},referenceYear:nullable('integer'),nameSource:nullable('string')}),{type:'null'}]},
  Session: {oneOf:[{type:'object',properties:{key:nullable('integer'),circuit:{type:'string'},name:{type:'string'},start:nullable('string')},required:['key','circuit','name']},{type:'null'}]},
  Connection: object({state:{type:'string'},message:{type:'string'},retryAt:{type:'number'}},['state','message']),
  Live: object({connection:ref('Connection'),auth:ref('Auth'),session:ref('Session'),sessionStatus:nullable('string')},['connection','auth']),
  Progress: object({completed:{type:'integer'},total:{type:'integer'},missingDrivers:array({type:'integer'})}),
  Playback: object({time:nullable('number'),start:nullable('number'),end:nullable('number'),playing:{type:'boolean'},speed:{type:'number'},supportedSpeeds:array({type:'number'})}),
  Settings: object({selectedDriver:nullable('integer'),selectedTurn:nullable('string'),notifications:array({type:'string'}),overlays:ref('Overlays'),cameras:{...array(ref('Camera')),maxItems:4}}),
  Radio: {oneOf:[object({clipId:{type:'string'},playing:{type:'boolean'},time:{type:'number'},title:{type:'string'},eventTime:{type:'number'}}),{type:'null'}]},
  Availability: {type:'object',description:'Per-source status. car_data (optional HUD telemetry) loads after the race is ready and reports completed/total cars and missingDrivers; live views report it unavailable.',additionalProperties:object({status:{enum:['loading','available','empty','error','unavailable']},count:{type:'integer'},completed:{type:'integer'},total:{type:'integer'},missingDrivers:array({type:'integer'}),message:{type:'string'}},['status'])},
  View: object({id:{type:'string',format:'uuid'},motionEpoch:{type:'string'},sequence:{type:'integer'},revision:{type:'integer'},serverTime:{type:'number'},source:ref('Source'),status:{type:'string'},message:{type:'string'},session:ref('Session'),auth:{oneOf:[ref('Auth'),{type:'null'}]},liveStatus:{oneOf:[object({session:nullable('string'),track:nullable('string'),updatedAt:nullable('number')}),{type:'null'}]},playback:ref('Playback'),rendering:object({maxGapMs:{type:'number'},staleAfterMs:{type:'number'},liveBufferMs:{type:'number'}}),settings:ref('Settings'),radio:ref('Radio'),progress:ref('Progress'),cars:array(ref('Car')),lap:nullable('integer'),totalLaps:nullable('integer'),events:ref('Events'),geometryRevision:{type:'string'},geometry:ref('Geometry'),availability:ref('Availability')},['id','motionEpoch','sequence','revision','serverTime','source','status','message','session','auth','liveStatus','playback','rendering','settings','radio','progress','cars','lap','totalLaps','events','geometryRevision','availability']),
  Race: {type:'object',properties:{session_key:{type:'integer'},circuit_key:{type:'integer'},circuit_short_name:{type:'string'},date_start:{type:'string'},date_end:{type:'string'},year:{type:'integer'}},required:['session_key','circuit_key','circuit_short_name','date_start','date_end']},
  Races: object({races:array(ref('Race')),circuits:array(object({id:{type:'integer'},name:{type:'string'}}))}),
  System: object({apiVersion:{const:'1'},instanceId:{type:'string'},serverTime:{type:'number'},sources:array(ref('Source')),independentViews:{const:true},autoConnect:{const:false},capabilities:object({stream:{const:'websocket'},f1PasswordLogin:{const:true},liveTurns:{const:false}})})
};
schemas.StreamTicket = object({ticket:{type:'string',writeOnly:false,description:'Single-use connection credential. Never put in URLs or logs.'},expiresAt:{type:'number'},url:{const:'/api/v1/socket'},protocolVersion:{const:1}});
schemas.TelemetrySample = {type:'array',description:'Sample-and-hold car_data row. Show the latest sample at or before presentation time; never interpolate; hide when older than rendering.maxGapMs. null = value not supplied.',prefixItems:[{type:'number',description:'UTC milliseconds'},{type:['integer','null'],description:'speed km/h'},{type:['integer','null'],description:'gear'},{type:['integer','null'],description:'rpm'},{type:['integer','null'],description:'throttle %'},{type:['integer','null'],description:'brake %'},{type:['boolean','null'],description:'DRS open (server-decoded from OpenF1 codes 10/12/14)'}],minItems:7,maxItems:7};
schemas.Coordinates = object({type:{const:'coordinates'},sequence:{type:'integer'},epoch:{type:'string'},replace:{type:'boolean'},from:nullable('number'),until:nullable('number'),latest:nullable('number'),cars:array(object({driverNumber:{type:'integer'},points:array(ref('Point')),telemetry:{...array(ref('TelemetrySample')),description:'Replay only, only for the telemetry set (camera drivers plus the selected driver, else P1); covers from..until plus one predecessor sample'}},['driverNumber','points']))});
schemas.SnapshotMessage = object({type:{const:'snapshot'},sequence:{type:'integer'},state:ref('View')});
schemas.StateMessage = object({type:{const:'state'},sequence:{type:'integer'},epoch:{type:'string'},serverTime:{type:'number'},viewSequence:{type:'integer'},revision:{type:'integer'},changes:{...schemas.View,required:[]},cars:object({upsert:array({...schemas.Car,required:['driverNumber']}),remove:array({type:'integer'})})});
schemas.StreamError = object({type:{const:'error'},sequence:{type:'integer'},code:{type:'string'},message:{type:'string'}});
schemas.StreamAuth = object({type:{const:'auth'},ticket:{type:'string'}});
schemas.StreamAck = object({type:{const:'ack'},sequence:{type:'integer'}});
schemas.StreamPing = object({type:{const:'ping'},sentAt:{type:'number'}});
schemas.StreamPong = object({type:{const:'pong'},sentAt:{type:'number'},serverTime:{type:'number'}});
const paths={};
const add=(path,method,summary,response,{body,status=200,parameters=[],contentType='application/json'}={})=>{
  paths[path]??={};
  paths[path][method]={operationId:method+path.replace(/[^a-z\d]/gi,'_'),summary,parameters,security:[{bearerAuth:[]}],
    ...(body?{requestBody:{required:true,content:{'application/json':{schema:ref(body)}}}}:{}),
    responses:{[status]:{description:'Success',...(response?{content:{[contentType]:{schema:typeof response==='string'?ref(response):response}}}:{})},
      ...Object.fromEntries([400,401,403,404,409,413,415,422,426,429,502].map(code=>[code,{description:'Explicit API error',content:{'application/json':{schema:ref('Error')}}}]))}};
};
const viewId={name:'id',in:'path',required:true,schema:{type:'string',format:'uuid'}};
add('/system','get','Server capabilities and restart identity','System');
add('/openapi.json','get','API contract',{type:'object'});
add('/races','get','Discover completed races and available circuits','Races',{parameters:[{name:'year',in:'query',required:true,schema:{type:'integer',minimum:2023}},...['month','circuit'].map(name=>({name,in:'query',schema:{type:'integer',minimum:1}}))]});
add('/views','post','Create an independent view; historical loading runs asynchronously','View',{body:'ViewCreate',status:201});
add('/views/{id}','get','Current server-calculated state including geometry','View',{parameters:[viewId]});
add('/views/{id}','patch','Set source, race, selections, overlays, notification filters and camera windows','View',{parameters:[viewId],body:'ViewPatch'});
add('/views/{id}','delete','Release view and cancel unreferenced loading',null,{parameters:[viewId],status:204});
add('/views/{id}/playback','post','Control the independent server replay clock','View',{parameters:[viewId],body:'PlaybackCommand'});
add('/views/{id}/radio','post','Select/play/pause/seek/stop client audio; selecting a clip pauses replay','View',{parameters:[viewId],body:'RadioCommand'});
add('/views/{id}/events','get','Read filtered notifications up to the view time','Events',{parameters:[viewId,...['offset','limit'].map(name=>({name,in:'query',schema:{type:'integer',minimum:name==='offset'?0:1,...(name==='limit'?{maximum:100}:{})}}))]});
add('/views/{id}/stream-ticket','post','Issue a single-use view-bound WebSocket ticket valid for 10 seconds','StreamTicket',{parameters:[viewId],body:'Empty',status:201});
add('/media/radio/{clipId}','get','Authenticated MP3 bytes; clip IDs are scoped to the source session',{type:'string',format:'binary'},{parameters:[{name:'clipId',in:'path',required:true,schema:{type:'string'}}],contentType:'audio/mpeg'});
add('/f1/auth','get','F1 sign-in status; never returns F1 credentials','Auth');
add('/f1/auth/login','post','Email/password sign-in; no automatic live connection','Auth',{body:'Login'});
add('/f1/auth/logout','post','Cancel pending login, disconnect and remove local F1 sign-in','Auth',{body:'Empty'});
add('/live','get','Shared live connection and session status','Live');
add('/live/connect','post','Explicitly request the shared F1 connection','Live',{body:'Empty',status:202});
add('/live/disconnect','post','Stop the shared F1 connection; keep saved sign-in','Live',{body:'Empty'});
export const openapi={openapi:'3.1.0',info:{title:'F1 Replay API',version:'2.1.0',description:'Single-owner API. Every application endpoint requires an application bearer token, separate from the private F1 subscription token. All numeric timestamps are UTC milliseconds, radio offsets are seconds. Views are ephemeral; recreate after restart or 30 minutes without requests. F1 connects only on explicit request. No live backfill or source substitution.'},servers:[{url:'/api/v1'}],security:[{bearerAuth:[]}],paths,'x-websocket':{url:'/api/v1/socket',protocolVersion:1,clientMessages:['StreamAuth','StreamAck','StreamPing'].map(ref),serverMessages:['SnapshotMessage','StateMessage','Coordinates','StreamError','StreamPong'].map(ref)},components:{securitySchemes:{bearerAuth:{type:'http',scheme:'bearer',description:'Provision with npm run api:setup; display in your terminal with npm run api:token.'}},schemas}};
