import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeState,APIClient} from '../public/api-client.js';
test('state deltas merge car patches, reject obsolete view sequences and preserve geometry',()=>{
 const state={motionEpoch:'h/1/0',sequence:3,cars:[{driverNumber:1,name:'Driver',lap:1}],geometry:{points:[]}};
 const delta={type:'state',epoch:'h/1/0',viewSequence:4,revision:1,serverTime:10,changes:{lap:2},cars:{upsert:[{driverNumber:1,lap:2}],remove:[]}};
 const next=mergeState(state,delta);assert.equal(next.cars[0].name,'Driver');assert.equal(next.cars[0].lap,2);assert.equal(next.geometry,state.geometry);assert.equal(mergeState(next,delta),next);assert.equal(mergeState(state,{...delta,epoch:'old'}),state);
});
test('browser API transport attaches the bearer to JSON, stream and audio requests without URL credentials',async()=>{
 const saved=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({ok:true}));};
 try{const api=new APIClient('unit-secret');await api.request('/f1/auth/login',{method:'POST',body:{email:'a',password:'unit-password'}});await api.audio('unit-clip');for(const call of calls){assert.equal(call.options.headers.Authorization,'Bearer unit-secret');assert.equal(call.url.includes('unit-secret'),false);}assert.equal(JSON.parse(calls[0].options.body).password,'unit-password');}finally{globalThis.fetch=saved;}
});
