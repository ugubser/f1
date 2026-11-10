import {test} from 'node:test';
import assert from 'node:assert/strict';
import {indexIntervals,timingValue,timingAt,formatTiming} from '../public/replay.js';
const base=Date.parse('2024-09-01T13:00:00Z');
const iso=seconds=>new Date(base+seconds*1000).toISOString();
const row=(seconds,driver,interval,gap)=>({date:iso(seconds),driver_number:driver,interval,gap_to_leader:gap});
const context={position:3,positionSince:base,aheadSince:base,leaderSince:base,raceStart:base};
const seconds=value=>({unit:'seconds',value});
test('P1 is the reference, P2 has the same two gaps, and P3 has adjacent and total gaps',()=>{
  const index=indexIntervals([row(5,2,1.2,1.2),row(5,3,2.3,3.5)]);
  const leader=timingAt([],base+6000,{...context,position:1});
  assert.equal(leader.status,'leader');assert.equal(leader.ahead,null);assert.deepEqual(leader.leader,seconds(0));
  const p2=timingAt(index.get(2),base+6000,{...context,position:2});
  assert.deepEqual(p2.ahead,seconds(1.2));assert.deepEqual(p2.leader,p2.ahead);
  const p3=timingAt(index.get(3),base+6000,context);
  assert.deepEqual(p3.ahead,seconds(2.3));assert.deepEqual(p3.leader,seconds(3.5));
  assert.equal(Math.round((p2.ahead.value+p3.ahead.value)*1000),p3.leader.value*1000);
});
test('timing seeks in both directions without future values or interpolation',()=>{
  const rows=indexIntervals([row(10,3,2,4),row(5,3,1,3)]).get(3);
  assert.equal(timingAt(rows,base+4999,context).leader,null);
  assert.equal(timingAt(rows,base+5000,context).leader.value,3);
  assert.equal(timingAt(rows,base+9000,context).leader.value,3);
  assert.equal(timingAt(rows,base+10000,context).leader.value,4);
  assert.equal(timingAt(rows,base+6000,context).leader.value,3);
});
test('formation-lap values do not appear in the race and unknown positions have no gap',()=>{
  const rows=indexIntervals([row(-1,3,1,2)]).get(3);
  assert.equal(timingAt(rows,base+1000,context).leader,null);
  assert.equal(timingAt(rows,base-1,{...context,position:1}).leader,null);
  assert.equal(timingAt([],base+1000,{...context,position:null}).status,'unavailable');
  assert.equal(timingAt([],base+1000,{...context,position:0}).leader,null);
});
test('stale samples expire at 15 seconds and inactive cars have no current gaps',()=>{
  const rows=indexIntervals([row(1,3,1,2)]).get(3);
  assert.equal(timingAt(rows,base+16000,context).status,'recorded');
  const stale=timingAt(rows,base+16001,context);assert.equal(stale.status,'stale');assert.equal(stale.ahead,null);assert.equal(stale.leader,null);assert.equal(stale.sampleTime,base+1000);
  assert.equal(timingAt(rows,base+6000,{...context,active:false}).status,'inactive');
  assert.equal(timingAt([],base+6000,{...context,position:1,active:false}).leader,null);
});
test('a changed driver position invalidates both gaps until a later sample',()=>{
  const rows=indexIntervals([row(5,3,1,2),row(9,3,3,4)]).get(3),changed={...context,positionSince:base+7000};
  assert.equal(timingAt(rows,base+8000,changed).status,'pending');
  const updated=timingAt(rows,base+9000,changed);assert.equal(updated.ahead.value,3);assert.equal(updated.leader.value,4);
});
test('changed rivals invalidate only their respective comparison',()=>{
  const rows=indexIntervals([row(5,3,1,2)]).get(3);
  const changedAhead=timingAt(rows,base+8000,{...context,aheadSince:base+7000});
  assert.equal(changedAhead.ahead,null);assert.equal(changedAhead.leader.value,2);
  const changedLeader=timingAt(rows,base+8000,{...context,leaderSince:base+7000});
  assert.equal(changedLeader.leader,null);assert.equal(changedLeader.ahead.value,1);
  assert.equal(timingAt(rows,base+8000,{...context,aheadSince:null}).ahead,null);
  assert.equal(timingAt(rows,base+8000,{...context,leaderSince:null}).leader,null);
});
test('lap gaps remain laps even when the interval ahead is in seconds',()=>{
  const rows=indexIntervals([row(5,3,2.345,'+1 LAP')]).get(3),result=timingAt(rows,base+6000,context);
  assert.equal(formatTiming(result.ahead),'+2.345s');assert.equal(formatTiming(result.leader),'+1 LAP');
  assert.equal(formatTiming(timingValue('+2 LAPS')),'+2 LAPS');
  assert.equal(formatTiming(timingValue('+1 LAP')),'+1 LAP');
});
test('missing and malformed values are not zero and never borrow an earlier measurement',()=>{
  for(const value of [null,undefined,NaN,Infinity,-1,'bad','1.23','+0 LAP'])assert.equal(timingValue(value),null);
  const rows=indexIntervals([row(5,3,1,2),row(6,3,null,null)]).get(3),result=timingAt(rows,base+6000,context);
  assert.equal(result.ahead,null);assert.equal(result.leader,null);assert.equal(result.status,'unavailable');assert.equal(formatTiming(null),'—');
  assert.equal(formatTiming(timingValue(0)),'+0.000s');
});
test('indexing groups drivers, sorts samples and ignores invalid timestamps or driver numbers',()=>{
  const index=indexIntervals([row(6,3,2,3),row(5,2,1,1),row(5,3,1,2),{...row(4,3,1,1),date:'bad'},row(5,null,1,1)]);
  assert.equal(index.size,2);assert.equal(index.get(3).length,2);assert.equal(index.get(3)[0].time,base+5000);
});
test('the recorded total is preserved when asynchronous intervals do not sum exactly',()=>{
  const rows=indexIntervals([row(5,3,3.762,6.725)]).get(3);
  assert.equal(timingAt(rows,base+6000,context).leader.value,6.725);
});
