import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyBundleTrust} from '../public/vault-trust.js';

const read=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));

test('signed official fixture is accepted',async()=>{
  assert.equal(await verifyBundleTrust(read('./fixtures/signed-synthetic.json')),'signed');
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
