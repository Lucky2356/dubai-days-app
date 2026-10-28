import test from 'node:test';
import assert from 'node:assert/strict';
import {initPwaUpdates} from '../public/vault-pwa.js';

function environment(flush){
  const messages=[],listeners=new Map();let reloads=0;
  const controls=Object.fromEntries(['updateNotice','updateText','applyUpdate'].map(name=>[name,{hidden:name==='updateNotice',disabled:false,textContent:'',addEventListener(type,fn){this[type]=fn}}]));
  const registration={waiting:{postMessage:message=>messages.push(message)},addEventListener(type,fn){listeners.set('registration:'+type,fn)}};
  const serviceWorker={controller:{},addEventListener(type,fn){listeners.set(type,fn)},register:async()=>registration,getRegistration:async()=>registration};
  const ready=initPwaUpdates(flush,{serviceWorker,get:id=>controls[id],reload:()=>{reloads++}});
  return {ready,controls,messages,listeners,registration,get reloads(){return reloads}};
}

test('new version appears but never reloads automatically',async()=>{
  const e=environment(async()=>{});await e.ready;
  assert.equal(e.controls.updateNotice.hidden,false);
  e.listeners.get('controllerchange')();
  assert.equal(e.reloads,0);
});

test('update waits for successful encrypted save before activating',async()=>{
  let saved=false;
  const e=environment(async()=>{saved=true});await e.ready;
  await e.controls.applyUpdate.click();
  assert.equal(saved,true);
  assert.deepEqual(e.messages,[{type:'APPLY_UPDATE'}]);
  assert.equal(e.reloads,0);
  e.listeners.get('controllerchange')();
  assert.equal(e.reloads,1);
});

test('failed save prevents service worker activation and keeps page',async()=>{
  const e=environment(async()=>{throw Error('disk full')});await e.ready;
  await e.controls.applyUpdate.click();
  assert.deepEqual(e.messages,[]);
  assert.equal(e.reloads,0);
  assert.equal(e.controls.applyUpdate.disabled,false);
  assert.match(e.controls.updateText.textContent,/disk full/);
});
