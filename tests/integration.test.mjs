import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import {keyFromPassword,encryptValue,decryptValue,unbase64} from '../public/vault-crypto.js';

const source=readFileSync(new URL('../public/vault.js',import.meta.url),'utf8');

function mockIndexedDB(){
  const store=new Map();let failWrites=false;
  const db={
    objectStoreNames:{contains:()=>true},close(){},
    transaction(){
      const tx={objectStore:()=>({
        get(key){const request={};queueMicrotask(()=>{request.result=store.get(key);request.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.())});return request},
        put(value,key){const request={};queueMicrotask(()=>{if(failWrites){tx.onerror?.();return}store.set(key,value);request.onsuccess?.();queueMicrotask(()=>tx.oncomplete?.())});return request},
      })};return tx;
    },
  };
  return {open(){const request={};queueMicrotask(()=>{request.result=db;request.onsuccess?.()});return request},setFailWrites:value=>{failWrites=value}};
}

function vaultContext(){
  const indexedDB=mockIndexedDB();
  const ctx={indexedDB,crypto:webcrypto,TextEncoder,TextDecoder,Uint8Array,btoa,atob,console};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('const DB_NAME='),source.indexOf('function status('))+'\nthis.database=database;',ctx);
  return {api:{database:ctx.database,keyFromPassword,encryptValue,decryptValue,unbase64},indexedDB};
}

function bundleValidator(){
  const ctx={FORMAT:'dubai-days-private-import-v1',ITERATIONS:310000};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function validateBundle('),source.indexOf('function sameStages('))+'\nthis.validate=validateBundle;',ctx);
  return ctx.validate;
}

function syntheticBundle(){
  return {
    format:'dubai-days-private-import-v1',version:50,
    html:'<div id="appScreen"></div><script src="./app.js"></script>',
    data:{trip:{days:Array.from({length:8},(_,i)=>({date:`2027-02-${22+i}`,legs:[]}))},geometry:{}},
    scripts:Object.fromEntries(['content.js','companion.js','travel-logic.js','app.js','route-focus.js','offline-atlas.js','travel-tools.js'].map(name=>[name,''])),
    styles:{'styles.css':''},assets:{hero:'placeholder',emergencyPdf:'placeholder'},
  };
}

function backupInspector(){
  const ctx={FORMAT:'dubai-days-private-import-v1',ITERATIONS:310000,keyFromPassword,decryptValue,unbase64};
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('function validateBundle('),source.indexOf('function sameStages(')),ctx);
  vm.runInContext(source.slice(source.indexOf('function validateProtectedRecord('),source.indexOf('const privateKeyName=')),ctx);
  vm.runInContext(source.slice(source.indexOf('async function inspectProtectedBackup('),source.indexOf('async function verifyProtectedBackup('))+'\nthis.inspect=inspectProtectedBackup;',ctx);
  return ctx.inspect;
}

test('encrypted vault survives simulated close and reopen',async()=>{
  const {api}=vaultContext();
  const salt=webcrypto.getRandomValues(new Uint8Array(16));
  const key=await api.keyFromPassword('integration password 123',salt);
  const original={bundle:{version:50},storage:{note:'Сохранённая заметка'},tickets:{a:{name:'test.pdf',body:'AQID'}}};
  await api.database('put',await api.encryptValue(original,key,salt));
  const stored=await api.database('get');
  assert.ok(!JSON.stringify(stored).includes('Сохранённая заметка'));
  const reopened=await api.decryptValue(stored,await api.keyFromPassword('integration password 123',api.unbase64(stored.salt)));
  assert.deepEqual(JSON.parse(JSON.stringify(reopened)),original);
});

test('failed storage write leaves last encrypted copy intact',async()=>{
  const {api,indexedDB}=vaultContext();
  const salt=webcrypto.getRandomValues(new Uint8Array(16));
  const key=await api.keyFromPassword('integration password 123',salt);
  const first=await api.encryptValue({storage:{note:'original'}},key,salt);
  await api.database('put',first);
  indexedDB.setFailWrites(true);
  await assert.rejects(api.database('put',await api.encryptValue({storage:{note:'unsaved'}},key,salt)),/Не удалось сохранить/);
  assert.equal((await api.database('get')).ciphertext,first.ciphertext);
});

test('PWA manifest has real install icons and matching assets',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../public/manifest.webmanifest',import.meta.url),'utf8'));
  assert.equal(manifest.display,'standalone');
  for(const size of [192,512]){
    const icon=manifest.icons.find(item=>item.sizes===`${size}x${size}`&&item.type==='image/png');
    assert.ok(icon,`Missing ${size}px PNG icon`);
    const url=new URL(`../public/${icon.src.replace('./','')}`,import.meta.url);
    assert.ok(existsSync(url));
    const png=readFileSync(url);
    assert.equal(png.subarray(1,4).toString(),'PNG');
    assert.equal(png.readUInt32BE(16),size);
    assert.equal(png.readUInt32BE(20),size);
  }
});

test('synthetic eight-day itinerary passes basic structure validation',()=>{
  assert.equal(bundleValidator()(syntheticBundle()).version,50);
});

test('import rejects injected HTML and unsafe navigation schemes',()=>{
  const validate=bundleValidator();
  const unsafe=syntheticBundle();unsafe.data.trip.days[0].title='<img src=x onerror=alert(1)>';
  assert.throws(()=>validate(unsafe),/небезопасный HTML/);
  const executable=syntheticBundle();executable.html+='<script>alert(1)</script>';
  assert.throws(()=>validate(executable),/неподдерживаемый HTML/);
});

test('import rejects incomplete itinerary and missing modules',()=>{
  const validate=bundleValidator();
  const missingDay=syntheticBundle();missingDay.data.trip.days.pop();
  assert.throws(()=>validate(missingDay),/не подходящий файл/);
  const missingScript=syntheticBundle();delete missingScript.scripts['app.js'];
  assert.throws(()=>validate(missingScript),/отсутствуют компоненты/);
});

test('downloaded encrypted backup can be verified without replacing data',async()=>{
  const salt=webcrypto.getRandomValues(new Uint8Array(16));
  const password='backup verification password 123';
  const key=await keyFromPassword(password,salt);
  const record=await encryptValue({bundle:syntheticBundle(),storage:{note:'private'},tickets:{one:{body:'AQID'}}},key,salt);
  assert.deepEqual(JSON.parse(JSON.stringify(await backupInspector()(record,password))),{days:8,tickets:1});
  await assert.rejects(backupInspector()(record,'incorrect backup password'));
});

test('backup verification rejects missing tickets or invalid format',async()=>{
  const salt=webcrypto.getRandomValues(new Uint8Array(16));
  const password='backup verification password 123',key=await keyFromPassword(password,salt);
  const record=await encryptValue({bundle:syntheticBundle(),storage:{}},key,salt);
  await assert.rejects(backupInspector()(record,password),/отсутствуют сохранённые/);
  await assert.rejects(backupInspector()({...record,format:'unexpected'},password),/не зашифрованная копия/);
});
