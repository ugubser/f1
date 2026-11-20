import {test} from 'node:test';
import assert from 'node:assert/strict';
import {embankment,clearanceFor,sectorIndices,offTrackRuns,createMapper,referenceZMin,smoothPath,ribbon,kerbs,startLine,buildTrack,tangents,leftNormal,pitPoints,wrapAngle,angleDelta,dampAngle,damp,headingVector,sessionHeading,nearestIndex,nearestIndexAround,heightAt} from '../public/track3d.js';

const circle=(r,n,{y=k=>0,phase=0}={})=>Array.from({length:n},(_,k)=>{const a=phase+k/n*2*Math.PI;return [r*Math.cos(a),y(k),r*Math.sin(a)];});
function segmentsIntersect(a,b,c,d){const o=(p,q,r)=>(q[0]-p[0])*(r[2]-p[2])-(q[2]-p[2])*(r[0]-p[0]);const d1=o(c,d,a),d2=o(c,d,b),d3=o(a,b,c),d4=o(a,b,d);return d1*d2<0&&d3*d4<0;}
function selfIntersects(line,closed=true){const n=line.length,segs=closed?n:n-1;for(let i=0;i<segs;i++)for(let j=i+2;j<segs;j++){if(closed&&i===0&&j===segs-1)continue;if(segmentsIntersect(line[i],line[(i+1)%n],line[j],line[(j+1)%n]))return true;}return false;}

test('session to world mapping follows E3 (decimetres, Z = −y, Y from zMin) and round-trips',()=>{
 const m=createMapper(1800);assert.deepEqual(m.toWorld(100,-250,1850),[10,5,25]);const back=m.toSession(10,5,25);assert.ok(Math.abs(back.x-100)<1e-9&&Math.abs(back.y+250)<1e-9&&Math.abs(back.z-1850)<1e-9);
 assert.deepEqual(m.toWorld(1,2,undefined),[0.1,0,-0.2]);
 assert.equal(referenceZMin({points:[[0,1,1,1900],[1,2,2,1843],[2,3,3,1967]],pitLane:{points:[[1,1,1840]]}}),1840);assert.equal(referenceZMin({points:[[0,1,1]]}),0);
});
test('smoothed closed centerline passes through samples, starts at points[0] and is uniformly spaced',()=>{
 const control=circle(100,24,{y:k=>Math.sin(k/24*2*Math.PI)*5}),path=smoothPath(control,{spacing:2});
 assert.deepEqual(path[0].map(v=>+v.toFixed(9)),control[0].map(v=>+v.toFixed(9)));
 const steps=path.map((p,i)=>Math.hypot(...p.map((v,k)=>v-path[(i+1)%path.length][k])));assert.ok(Math.max(...steps)-Math.min(...steps)<0.05,'uniform spacing');
 for(const p of path)assert.ok(Math.abs(Math.hypot(p[0],p[2])-100)<0.5,'stays near the circle');
 const length=steps.reduce((a,b)=>a+b,0);assert.ok(Math.abs(length-2*Math.PI*100)<2);
 // Elevation is preserved: the curve still reaches the recorded heights.
 const ys=path.map(p=>p[1]);assert.ok(Math.max(...ys)>4.9&&Math.min(...ys)<-4.9);
 // Duplicate samples (stopped car / repeated rows) do not create degenerate segments.
 const dup=smoothPath([...control.slice(0,5),control[4],control[4],...control.slice(5)],{spacing:2});assert.ok(dup.every(p=>p.every(Number.isFinite)));
});
test('closed ribbon on a circle has exact width, preserved elevation and no self-intersection',()=>{
 const center=smoothPath(circle(40,30,{y:k=>k%2}),{spacing:2}),road=ribbon(center,12);
 assert.equal(road.positions.length,center.length*6);assert.equal(road.indices.length,center.length*6);
 for(let i=0;i<center.length;i++){assert.ok(Math.abs(Math.hypot(road.left[i][0]-road.right[i][0],road.left[i][2]-road.right[i][2])-12)<1e-9,'width');assert.equal(road.left[i][1],center[i][1]);assert.equal(road.right[i][1],center[i][1]);
  // left/right are perpendicular to the averaged tangent
  const t=road.tangents[i],lx=road.left[i][0]-center[i][0],lz=road.left[i][2]-center[i][2];assert.ok(Math.abs(lx*t[0]+lz*t[1])<1e-9);}
 assert.equal(selfIntersects(road.left),false);assert.equal(selfIntersects(road.right),false);assert.equal(selfIntersects(center),false);
 // Anticlockwise from above (+Y up, X→Z): inner edge is the left one for a loop running −Z-wards... check one edge is inside, one outside.
 const rl=Math.hypot(road.left[0][0],road.left[0][2]),rr=Math.hypot(road.right[0][0],road.right[0][2]);assert.ok(Math.abs(Math.abs(rl-rr)-12)<0.1);
 // Every triangle faces up (counter-clockwise seen from +Y).
 const P=i=>[road.positions[i*3],road.positions[i*3+1],road.positions[i*3+2]];
 for(let k=0;k<road.indices.length;k+=3){const [a,b,c]=[0,1,2].map(j=>P(road.indices[k+j])),ny=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]);assert.ok(ny>0,'upward face');}
});
test('heading helpers: left normal, world heading vector, wrap and damping take the short way round',()=>{
 assert.deepEqual(leftNormal([1,0]),[0,-1]);const v=headingVector(Math.PI/2);assert.ok(Math.abs(v[0])<1e-12&&Math.abs(v[2]+1)<1e-12);assert.equal(sessionHeading(0,1),Math.PI/2);
 assert.ok(Math.abs(wrapAngle(3*Math.PI)-Math.PI)<1e-12||Math.abs(wrapAngle(3*Math.PI)+Math.PI)<1e-12);assert.ok(Math.abs(angleDelta(3.1,-3.1)-(2*Math.PI-6.2))<1e-12);
 // Damping from +179° toward −179° moves forward through ±180°, never back through 0°.
 const a=dampAngle(Math.PI-0.02,-Math.PI+0.02,10,0.05);assert.ok(Math.abs(a)>Math.PI-0.03);assert.equal(damp(0,10,5,0),0);assert.ok(Math.abs(damp(0,10,5,100)-10)<1e-9);
 for(let k=0;k<50;k++){const d=dampAngle(0,2,3,k*0.01);assert.ok(d>=0&&d<=2);}
});
test('kerbs sit both sides of the nearest centerline point of each turn marker, start line spans the ribbon',()=>{
 const center=smoothPath(circle(100,40),{spacing:2}),corner=[0,0,100];const k=kerbs(center,[corner,[5000,0,0]],{width:12,kerbWidth:1.2,halfLength:10});
 assert.equal(k.placed.length,1,'far-away marker skipped');assert.equal(k.placed[0],nearestIndex(center,0,100).index);
 assert.equal(k.positions.length/3,2*10*4);const radii=[];for(let i=0;i<k.positions.length;i+=3){radii.push(Math.hypot(k.positions[i],k.positions[i+2]));assert.ok(Math.hypot(k.positions[i]-corner[0],k.positions[i+2]-corner[2])<20);}
 assert.ok(radii.some(r=>r<95)&&radii.some(r=>r>105),'both sides');assert.ok(radii.every(r=>Math.abs(Math.abs(r-100)-6.3)<0.7),'just inside the ribbon edge');
 const colors=new Set();for(let i=0;i<k.colors.length;i+=3)colors.add(k.colors.slice(i,i+3).join());assert.equal(colors.size,2);
 const s=startLine(center,{width:12});const xs=[];for(let i=0;i<s.positions.length;i+=3)xs.push(Math.hypot(s.positions[i],s.positions[i+2]));assert.ok(Math.abs(Math.max(...xs)-106)<0.1&&Math.abs(Math.min(...xs)-94)<0.1);
});
test('buildTrack maps API geometry: elevation, closed loop, pit lane optional, height lookup',()=>{
 const points=Array.from({length:60},(_,k)=>{const a=k/60*2*Math.PI;return [k*1000,3000*Math.cos(a),2000*Math.sin(a),1850+100*Math.sin(a)];});
 const geometry={points,corners:[{id:'1',x:3000,y:0,angle:90}],pitLane:null};
 const track=buildTrack(geometry);assert.equal(track.zMin,1750);assert.ok(Math.abs(track.bounds.maxY-20)<0.2&&track.bounds.minY>-0.2,'≈20 m elevation preserved');
 assert.ok(Math.abs(track.bounds.sizeX-600)<2&&Math.abs(track.bounds.sizeZ-400)<2);assert.equal(track.pit,null);assert.equal(track.kerbs.placed.length,1);assert.ok(track.groundY<=0);
 assert.equal(selfIntersects(track.ribbon.left),false);assert.equal(selfIntersects(track.ribbon.right),false);
 const withPit=buildTrack({...geometry,pitLane:{points:[[2900,-300,1860],[2900,0,1862],[2900,300,1864]]}});assert.ok(withPit.pit.center.length>10);assert.ok(Math.abs(withPit.pit.center[0][0]-290)<1e-6);
 assert.equal(pitPoints({pitLane:{points:[[1,2,3,4]]}})[0].join(),'2,3,4');assert.equal(buildTrack({points:[[0,1,1,1]]}),null);
 assert.ok(Math.abs(heightAt(track,0,-200)-track.center[nearestIndex(track.center,0,-200).index][1])<1e-12);
 // Tangents of the closed loop are unit length.
 for(const t of tangents(track.center))assert.ok(Math.abs(Math.hypot(...t)-1)<1e-9);
});
test('local nearest-index search matches a full scan and recovers from a stale hint',()=>{
 const center=smoothPath(circle(300,40),{spacing:2});
 for(const [X,Z,hint] of [[300,0,0],[0,300,center.length-3],[-300,5,10],[0,-310,500]]){const full=nearestIndex(center,X,Z),local=nearestIndexAround(center,X,Z,hint);assert.equal(local.index,full.index);}
 assert.equal(nearestIndexAround(center,300,0,undefined).index,nearestIndex(center,300,0).index);
});
test('camera grid: target resolution (driver → selected → P1) and auto layout tokens',async()=>{
 const {resolveTarget,layoutFor,DEFAULT_CAMERA,MAX_CAMERAS}=await import('../public/camera-grid.js');
 const state={settings:{selectedDriver:null},cars:[{driverNumber:4,position:2},{driverNumber:16,position:1}]};
 assert.equal(resolveTarget({driver:44},state),44);assert.equal(resolveTarget({driver:null},state),16);assert.equal(resolveTarget({driver:null},{...state,settings:{selectedDriver:4}}),4);assert.equal(resolveTarget({driver:null},{settings:{selectedDriver:null},cars:[]}),null);
 assert.deepEqual([0,1,2,3,4,7].map(n=>layoutFor(n,null)),['0','1','2','3','4','4']);assert.equal(layoutFor(2,'cam-1'),'max');
 assert.deepEqual(DEFAULT_CAMERA,{id:'cam-1',mode:'chase',driver:null,position:null,target:null,fov:55,hud:true});assert.equal(MAX_CAMERAS,4);
});

const upward=g=>{const P=i=>[g.positions[i*3],g.positions[i*3+1],g.positions[i*3+2]];for(let k=0;k<g.indices.length;k+=3){const [a,b,c]=[0,1,2].map(j=>P(g.indices[k+j]));if((b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2])<-1e-9)return false;}return true;};
test('embankments slope from the ribbon edge outward to the ground, wider where the track is higher, faces up',()=>{
 const center=smoothPath(circle(200,40,{y:k=>k<20?10:0}),{spacing:2}),road=ribbon(center,12);
 for(const [edge,side] of [[road.left,1],[road.right,-1]]){
  const e=embankment(edge,road.tangents,side,0,{slope:2,verge:1,drop:0.1});
  assert.equal(e.positions.length,edge.length*9);assert.ok(upward(e),'every triangle faces up');
  for(let i=0;i<edge.length;i++){const top=[e.positions[i*9],e.positions[i*9+1],e.positions[i*9+2]],foot=[e.positions[i*9+6],e.positions[i*9+7],e.positions[i*9+8]];
   assert.deepEqual(top,edge[i].map(v=>Math.fround(v)));assert.equal(foot[1],0,'foot on the ground');
   const out=Math.hypot(foot[0]-top[0],foot[2]-top[2]);assert.ok(Math.abs(out-Math.max(1.3,1+Math.max(0,edge[i][1]-0.1)*2))<1e-3,'width = verge + height·slope (min verge + 0.3)');
   // outward: the foot is farther from the centerline than the edge
   const c=center[i];assert.ok(Math.hypot(foot[0]-c[0],foot[2]-c[2])>Math.hypot(top[0]-c[0],top[2]-c[2]));}
 }
});
test('embankment clearance stops a slope short of a parallel lane and of a far part of its own loop',()=>{
 const main=Array.from({length:101},(_,i)=>[i*2,0,0]),lane=Array.from({length:101},(_,i)=>[i*2,0,-20]);
 const paths=[{points:main,halfWidth:6,closed:false},{points:lane,halfWidth:4,closed:false}],clear=clearanceFor(paths,paths[0]);
 // From the main left edge (z = −6) outward (−Z) the lane centre is 14 m away: stop 1 m before its 4 m half width.
 assert.ok(Math.abs(clear(50,[100,0,-6],0,-1,40)-9)<1e-9);assert.equal(clear(50,[100,0,6],0,1,40),Infinity,'nothing on the other side');
 const road=ribbon(main,12,{closed:false}),e=embankment(road.left,road.tangents,1,-10,{closed:false,clearance:clear,slope:2,verge:1,drop:0});
 const foot=e.positions[50*9+8];assert.ok(Math.abs(foot-(-6-9))<1e-3,'slope ends before the lane, not 21 m out');
});
test('sector indices map supplied sector start points onto the smoothed centerline in lap order',()=>{
 const raw=Array.from({length:60},(_,k)=>{const a=k/60*2*Math.PI;return [k,3000*Math.cos(a),3000*Math.sin(a),1800];});
 const sectors=[{number:1,points:[raw[0]]},{number:2,points:[[20,raw[20][1],raw[20][2]]]},{number:3,points:[[40,raw[40][1],raw[40][2]]]}];
 const track=buildTrack({points:raw,corners:[],sectors});assert.ok(track.sectors);assert.equal(track.sectors.length,track.center.length);
 assert.equal(track.sectors[0],1);assert.equal(track.sectors.at(-1),3);
 const third=track.center.length/3,first2=track.sectors.indexOf(2),first3=track.sectors.indexOf(3);assert.ok(Math.abs(first2-third)<3&&Math.abs(first3-2*third)<3);
 for(let i=1;i<track.sectors.length;i++)assert.ok(track.sectors[i]>=track.sectors[i-1],'monotonic');
 // Boundaries out of lap order or far from the circuit give no tint rather than a wrong one.
 assert.equal(sectorIndices(track.center,[sectors[0],sectors[2],{...sectors[1],number:3}],track.mapper),null);
 assert.equal(sectorIndices(track.center,[sectors[0],{number:2,points:[[1,99999,99999]]}],track.mapper),null);
 assert.equal(sectorIndices(track.center,[],track.mapper),null);assert.equal(buildTrack({points:raw,corners:[]}).sectors,null);
});
test('pit lane edge runs exclude the stretches that lie on the main ribbon; buildTrack adds embankments',()=>{
 const center=Array.from({length:200},(_,i)=>[i*2,0,0]);
 const pit=Array.from({length:50},(_,i)=>[100+i*2,0,i<10||i>=40?0:-15]);
 assert.deepEqual(offTrackRuns(pit,center,10),[[10,39]]);
 const points=Array.from({length:60},(_,k)=>{const a=k/60*2*Math.PI;return [k,3000*Math.cos(a),2000*Math.sin(a),1850+100*Math.sin(a)];});
 const track=buildTrack({points,corners:[],pitLane:{points:[[3000,-400,1850],[2850,-300,1850],[2850,0,1850],[2850,300,1850],[3000,400,1850]]}});
 assert.equal(track.embankments.length,2);assert.equal(track.pit.embankments.length,2);assert.ok(track.pit.edgeRuns.length>=1);
 for(const e of [...track.embankments,...track.pit.embankments])assert.ok(upward(e));
});
