import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {keyFromPassword,encryptValue,decryptValue,unbase64} from '../public/vault-crypto.js';

const source=readFileSync(new URL('../public/vault.js',import.meta.url),'utf8');
function syntheticBundle(){return {
  format:'dubai-days-private-import-v1',version:50,
  html:'<div id="appScreen"></div><script src="./app.js"></script>',
  data:{trip:{days:Array.from({length:8},(_,i)=>({date:`2027-02-${22+i}`,legs:[]}))},geometry:{}},
  scripts:Object.fromEntries(['content.js','companion.js','travel-logic.js','app.js','route-focus.js','offline-atlas.js','travel-tools.js'].map(name=>[name,''])),
  styles:{'styles.css':''},assets:{hero:'image',emergencyPdf:'pdf'},
}}
function harness(){
  const controls=Object.fromEntries(['importPassword','importConfirm','updatePassword','importFile','importButton','trustedImport','restoreFile','restorePassword','restoreButton','restoreFileName'].map(id=>[id,{value:'',disabled:false,checked:false,files:[]}]));
  let stored=null,failWrites=false,frameOpened=0,statusMessage='';
  const context={
    FORMAT:'dubai-days-private-import-v1',PASSWORD_MIN:12,MAX_RESTORE_BYTES:128*1024*1024,ITERATIONS:310000,
    crypto:webcrypto,Blob,Uint8Array,console,keyFromPassword,encryptValue,decryptValue,unbase64,
    $:id=>controls[id],status:text=>{statusMessage=text},flush:async()=>{},
    database:async(op,value)=>{if(op==='put'){if(failWrites)throw Error('Disk full');stored=value;return}return stored},
    findLegacyStorage:()=>({}),findLegacyTickets:async()=>({}),clearLegacy:async()=>{},
    buildPrivateHTML:()=>'<html></html>',unlockFrame:()=>{frameOpened++},confirm:()=>true,
  };
  vm.createContext(context);
  vm.runInContext('let encryptedRecord=null,session=null,sessionKey=null;',context);
  for(const [start,end] of [
    ['function validateBundle(','function sameStages('],
    ['function sameStages(','function validateProtectedRecord('],
    ['function validateProtectedRecord(','const privateKeyName='],
    ['async function handleImport(','async function exportProtectedBackup('],
  ])vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end)),context);
  vm.runInContext('this.state=()=>({encryptedRecord,session,sessionKey});this.handleImport=handleImport;this.handleRestore=handleRestore;',context);
  const event={preventDefault(){}};
  const pick=(id,data)=>{const json=JSON.stringify(data);controls[id].files=[{size:Buffer.byteLength(json),text:async()=>json}]};
  return {context,controls,event,pick,get stored(){return stored},get status(){return statusMessage},get frameOpened(){return frameOpened},failWrites:value=>{failWrites=value}};
}

test('import → save → reopen keeps itinerary notes and PDF ticket',async()=>{
  const h=harness(),password='safe unique password 123';
  h.controls.importPassword.value=password;h.controls.importConfirm.value=password;h.controls.trustedImport.checked=true;
  h.pick('importFile',syntheticBundle());
  await h.context.handleImport(h.event);
  assert.equal(h.frameOpened,1);
  const first=h.context.state();assert.ok(first.encryptedRecord);
  first.session.storage.note='A note written during the trip';
  first.session.tickets.ticket1={name:'boarding-pass.pdf',type:'application/pdf',body:'AQID'};
  const next=await encryptValue(first.session,first.sessionKey,unbase64(first.encryptedRecord.salt));
  const restored=await decryptValue(next,await keyFromPassword(password,unbase64(next.salt)));
  assert.equal(restored.storage.note,'A note written during the trip');
  assert.equal(restored.tickets.ticket1.body,'AQID');
  assert.equal(restored.bundle.data.trip.days.length,8);
});

test('restore replaces current synthetic vault only after validation',async()=>{
  const h=harness(),password='safe unique password 123';
  const salt=webcrypto.getRandomValues(new Uint8Array(16));
  const key=await keyFromPassword(password,salt);
  const record=await encryptValue({bundle:syntheticBundle(),storage:{note:'Recovered'},tickets:{t:{body:'AQID'}}},key,salt);
  h.controls.restorePassword.value=password;h.pick('restoreFile',record);
  await h.context.handleRestore(h.event);
  assert.equal(h.frameOpened,1);
  assert.equal(h.context.state().session.storage.note,'Recovered');
  assert.equal(h.context.state().session.tickets.t.body,'AQID');
});

test('failed import write never replaces previous encrypted record',async()=>{
  const h=harness(),password='safe unique password 123';
  h.controls.importPassword.value=password;h.controls.importConfirm.value=password;h.controls.trustedImport.checked=true;h.pick('importFile',syntheticBundle());
  await h.context.handleImport(h.event);
  const first=h.stored;
  h.failWrites(true);h.controls.updatePassword.value=password;h.controls.trustedImport.checked=true;h.pick('importFile',syntheticBundle());
  await h.context.handleImport(h.event);
  assert.equal(h.stored,first);
  assert.equal(h.context.state().encryptedRecord,first);
  assert.match(h.status,/Disk full/);
});
