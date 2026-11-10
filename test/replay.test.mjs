import {test} from 'node:test';
import assert from 'node:assert/strict';
import {positionAt,compactLocations,circuitFromLap,lapAt} from '../domain/replay.mjs';
test('cars share UTC clock; interpolate between samples',()=>{assert.deepEqual(positionAt([[1000,0,0],[2000,10,20]],1500),{x:5,y:10,stale:false});assert.equal(positionAt([[2000,10,20]],1500),null);});
test('missing samples and retired cars never interpolate through long gaps',()=>{const p=[[1000,10,20],[20000,200,400]];assert.equal(positionAt(p,10000),null);assert.equal(positionAt(p,30000),null);assert.equal(positionAt(p,1500).x,10);});
test('compaction sorts, removes zero/invalid coordinates and keeps endpoints',()=>{const r=[{date:'2024-01-01T00:00:02Z',x:20,y:30},{date:'2024-01-01T00:00:00Z',x:0,y:0},{date:'2024-01-01T00:00:01Z',x:10,y:20},{date:'bad',x:1,y:2}];assert.deepEqual(compactLocations(r).map(p=>p[1]),[10,20]);});
test('lap selection does not expose future laps',()=>{const laps=[{date_start:'2024-01-01T00:00:00Z',lap_number:1},{date_start:'2024-01-01T00:01:30Z',lap_number:2}];assert.equal(lapAt(laps,Date.parse('2024-01-01T00:01:00Z')).lap_number,1);});
test('track reconstruction rejects partial laps and accepts a closed lap',()=>{const base=Date.parse('2024-01-01T00:00:00Z');const points=Array.from({length:81},(_,i)=>[base+i*1000,Math.cos(i/80*2*Math.PI)*100,Math.sin(i/80*2*Math.PI)*100]);const laps=[{date_start:new Date(base).toISOString(),lap_number:2,lap_duration:80}];assert.equal(circuitFromLap(points,laps).length,81);assert.equal(circuitFromLap(points.slice(0,30),laps).length,0);});
