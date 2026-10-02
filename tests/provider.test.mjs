import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognizeSafely } from '../server/recognition/provider.mjs';
test('recognition off, exception, timeout and invalid candidates preserve import fallback',async()=>{
  assert.deepEqual(await recognizeSafely(null,'unused'),{status:'UNTRIED',candidates:[]});
  for(const provider of [async()=>{throw new Error('private-secret');},async()=>new Promise(()=>{}),async()=>({unexpected:'value'})]){
    const result=await recognizeSafely(provider,'unused',20);
    assert.equal(result.status,'FAILED'); assert.deepEqual(result.candidates,[]);
    assert.equal(JSON.stringify(result).includes('private-secret'),false);
  }
  const candidate={title:'Demo',artist:'Artist',confidence:0.7};
  assert.deepEqual((await recognizeSafely(async()=>[candidate],'unused')).candidates,[candidate]);
});
