import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pitLaneFromStops,distanceToPath} from '../domain/replay.mjs';
import {HistoryService} from '../services/history.mjs';
import {ViewService} from '../services/views.mjs';
import {fixtureLoad,fixtureCircuit,fakeLive,ready,points,pitPoints,start} from './fixtures.mjs';
const reference=points.slice(80,161),iso=t=>new Date(t).toISOString();
const pit={driver_number:2,date:iso(start+100000),lane_duration:20,lap_number:2};
test('pit lane is the recorded off-line run around a pit record, joined to the track at both ends',()=>{
 const lane=pitLaneFromStops(reference,[pit],new Map([[2,pitPoints]]));
 assert.equal(lane.driverNumber,2);assert.equal(lane.lap,2);assert.equal(lane.entryTime,start+100000);
 assert.equal(lane.points.length,27);assert.deepEqual(lane.points[0],pitPoints[97].slice(1));assert.deepEqual(lane.points.at(-1),pitPoints[123].slice(1));
 assert.ok(distanceToPath(reference,...lane.points[0].slice(0,2))<=40&&distanceToPath(reference,...lane.points.at(-1).slice(0,2))<=40);
 assert.ok(lane.points.slice(1,-1).every(p=>distanceToPath(reference,p[0],p[1])>40));
});
test('pit lane rejects gaps, position jumps, missing rejoin and on-line stops, then tries the next record; never borrows geometry',()=>{
 const gapped=pitPoints.filter((p,i)=>i!==110&&i!==111);
 assert.equal(pitLaneFromStops(reference,[pit],new Map([[2,gapped]])),null);
 assert.equal(pitLaneFromStops(reference,[pit],new Map([[2,pitPoints.slice(0,115)]])),null);
 assert.equal(pitLaneFromStops(reference,[{...pit,driver_number:1}],new Map([[1,points]])),null);
 assert.equal(pitLaneFromStops(reference,[{...pit,lane_duration:null}],new Map([[2,pitPoints]])),null);
 assert.equal(pitLaneFromStops([],[pit],new Map([[2,pitPoints]])),null);
 const second=pitLaneFromStops(reference,[{...pit,driver_number:1,date:iso(start+90000)},pit],new Map([[1,points],[2,pitPoints]]));assert.equal(second.driverNumber,2);
 const teleport=pitPoints.map((p,i)=>i===110?[p[0],p[1]+2000,p[2],p[3]]:p);assert.equal(pitLaneFromStops(reference,[pit],new Map([[2,teleport]])),null);
 const stationary=pitPoints.map((p,i)=>i>=105&&i<=110?[p[0],...pitPoints[105].slice(1)]:p);
 assert.equal(pitLaneFromStops(reference,[pit],new Map([[2,stationary]])).points.length,22);
});
test('geometry carries the recorded pit lane and approximate 0.1 m scale',async()=>{
 const views=new ViewService({history:new HistoryService({load:fixtureLoad(),loadCircuit:fixtureCircuit}),live:fakeLive().live}),v=views.create({source:'history',raceId:9590});
 try{const s=await ready(views,v.id);assert.deepEqual(s.geometry.scale,{metresPerUnit:.1,approximate:true});assert.equal(s.geometry.pitLane.driverNumber,2);assert.equal(s.geometry.pitLane.points.length,27);assert.equal(s.geometry.points[0].length,4);}finally{views.close();}
 const empty=new ViewService({history:new HistoryService({load:fixtureLoad({empty:['pit']}),loadCircuit:fixtureCircuit}),live:fakeLive().live}),e=empty.create({source:'history',raceId:9590});
 try{assert.equal((await ready(empty,e.id)).geometry.pitLane,null);}finally{empty.close();}
});
