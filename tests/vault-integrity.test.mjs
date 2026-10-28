import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import {keyFromPassword,encryptValue,decryptValue,unbase64} from '../public/vault-crypto.js';

const source=readFileSync(new URL('../public/vault.js',import.meta.url),'utf8');
const context={crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,btoa,atob,console};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function sameStages('),source.indexOf('function validateProtectedRecord('))+'\nthis.mappingApi={stageMapping,remapStageStorage,remapTravelExtras};',context);

test('AES-GCM round-trip preserves notes and tickets without plaintext leaks',async()=>{
  const salt=webcrypto.getRandomValues(new Uint8Array(16));
  const key=await keyFromPassword('a sufficiently long test password',salt);
  const data={bundle:{format:'dubai-days-private-import-v1'},storage:{notes:'Приватная запись'},tickets:{ticket1:{body:'AQID'}}};
  const encrypted=await encryptValue(data,key,salt);
  assert.equal(encrypted.format,'dubai-days-locked-v1');
  assert.ok(!JSON.stringify(encrypted).includes('Приватная запись'));
  assert.deepEqual(JSON.parse(JSON.stringify(await decryptValue(encrypted,key))),data);
  const second=await encryptValue(data,key,salt);
  assert.notEqual(encrypted.iv,second.iv);
  assert.notEqual(encrypted.ciphertext,second.ciphertext);
});

test('wrong password and modified ciphertext fail authentication',async()=>{
  const salt=webcrypto.getRandomValues(new Uint8Array(16));
  const key=await keyFromPassword('right password 123',salt);
  const encrypted=await encryptValue({storage:{note:'safe'}},key,salt);
  await assert.rejects(decryptValue(encrypted,await keyFromPassword('wrong password 123',salt)));
  const bytes=unbase64(encrypted.ciphertext);bytes[bytes.length-1]^=1;
  await assert.rejects(decryptValue({...encrypted,ciphertext:btoa(String.fromCharCode(...bytes))},key));
});

test('stage reorder preserves completion and progress',()=>{
  const make=legs=>({data:{trip:{days:[{date:'2027-02-22',legs}]}}});
  const a={mode:'walk',from:'hotel',to:'metro'},b={mode:'metro',from:'metro',to:'mall'};
  const mapping=context.mappingApi.stageMapping(make([a,b]),make([b,a]));
  assert.deepEqual(JSON.parse(JSON.stringify(mapping)),[[1,0]]);
  const storage={'dubai-days-personal-v1':JSON.stringify({completed:{'0':[0]},progress:{'0':1}})};
  const value=JSON.parse(context.mappingApi.remapStageStorage(storage,mapping)['dubai-days-personal-v1']);
  assert.deepEqual(value.completed,{'0':[1]});
  assert.deepEqual(value.progress,{'0':0});
  const extras={diary:{0:'Заметка'},checks:{0:['water']},plans:{0:{delay:60,skip:[0],savedAt:'2026-10-28'}}};
  const migrated=JSON.parse(JSON.stringify(context.mappingApi.remapTravelExtras(extras,mapping)));
  assert.deepEqual(migrated.plans[0].skip,[1]);
  assert.deepEqual(migrated.diary,extras.diary);
  assert.deepEqual(migrated.checks,extras.checks);
  assert.deepEqual(extras.plans[0].skip,[0],'original encrypted session is not mutated');
});

test('updating refuses to silently lose invalid alternative plans',()=>{
  assert.throws(()=>context.mappingApi.remapTravelExtras({plans:{0:{skip:[99]}}},[[1,0]]),/неизвестный этап/);
});

test('incompatible itinerary changes are rejected',()=>{
  const make=legs=>({data:{trip:{days:[{date:'2027-02-22',legs}]}}});
  assert.throws(()=>context.mappingApi.stageMapping(make([{mode:'walk',from:'A',to:'B'}]),make([{mode:'walk',from:'A',to:'C'}])),/Обновление отменено/);
});
