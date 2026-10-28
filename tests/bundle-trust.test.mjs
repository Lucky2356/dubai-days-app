import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {verifyBundleTrust} from '../public/vault-trust.js';

const read=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));

test('signed official fixture is accepted',async()=>{
  assert.equal(await verifyBundleTrust(read('./fixtures/signed-synthetic.json')),'signed');
});
test('large signed synthetic bundle is accepted and retains 61 fabricated stages',async()=>{
  const b=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/signed-stress.json.gz',import.meta.url))).toString('utf8'));
  assert.equal(await verifyBundleTrust(b),'signed');
  assert.equal(b.data.trip.days.reduce((sum,day)=>sum+day.legs.length,0),61);
});
test('changing route data invalidates the signature',async()=>{
  const bundle=read('./fixtures/signed-synthetic.json');bundle.data.trip.days[0].date='modified';
  await assert.rejects(verifyBundleTrust(bundle),/подпись/);
});
test('changing executable script invalidates the signature',async()=>{
  const bundle=read('./fixtures/signed-synthetic.json');bundle.scripts['app.js']='console.log("injected")';
  await assert.rejects(verifyBundleTrust(bundle),/подпись/);
});
test('unsigned arbitrary bundles are rejected',async()=>{
  await assert.rejects(verifyBundleTrust(read('./fixtures/unsigned-synthetic.json')),/не подтверждён/);
});
test('forged signature fails without falling back to legacy trust',async()=>{
  const bundle=read('./fixtures/signed-synthetic.json');bundle.signature.value='AAAA';
  await assert.rejects(verifyBundleTrust(bundle),/подпись/);
});
