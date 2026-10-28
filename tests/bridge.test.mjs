import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {base64,unbase64} from '../public/vault-crypto.js';

const source=readFileSync(new URL('../public/vault.js',import.meta.url),'utf8');
function harness(){
  const replies=[];const frame={postMessage:message=>replies.push(message)};
  let saves=0,failSave=false,warning='';
  const ctx={Blob,Uint8Array,base64,unbase64,MAX_TICKET_BASE64:40*1024*1024,
    location:{origin:'https://example.test'},privateKeyName:key=>/^dubai-days-personal-v1$/.test(key),
    navigator:{geolocation:{getCurrentPosition:onSuccess=>onSuccess({coords:{latitude:25.2,longitude:55.3,accuracy:100}})}},
    $:id=>id==='privateFrame'?{contentWindow:frame}:{},
    schedulePersist:()=>{saves++},flush:async()=>{if(failSave)throw Error('Disk full')},showSaveWarning:error=>{warning=error.message},
    Error,Object,console};
  vm.createContext(ctx);
  vm.runInContext('let session={storage:{},tickets:{}},sessionToken="test-token",lastPersistError=null;',ctx);
  vm.runInContext(source.slice(source.indexOf('async function handleVaultMessage('),source.indexOf("window.addEventListener('message',handleVaultMessage)"))+'\nthis.handle=handleVaultMessage;this.current=()=>session;',ctx);
  const event=(type,more={})=>({origin:'null',source:frame,data:{type,token:'test-token',requestId:1,...more}});
  return {ctx,event,replies,get saves(){return saves},get warning(){return warning},failSave:value=>{failSave=value}};
}

test('PDF ticket put, get, all and delete round-trip through the secure bridge',async()=>{
  const h=harness();
  await h.ctx.handle(h.event('vault-ticket',{kind:'put',id:'boarding',record:{name:'boarding.pdf',type:'application/pdf',blob:new Blob([Uint8Array.from([1,2,3])],{type:'application/pdf'})}}));
  assert.equal(h.replies.at(-1).error,null);
  assert.equal(h.saves,1);
  await h.ctx.handle(h.event('vault-ticket',{kind:'get',id:'boarding'}));
  assert.deepEqual([...new Uint8Array(await h.replies.at(-1).result.blob.arrayBuffer())],[1,2,3]);
  await h.ctx.handle(h.event('vault-ticket',{kind:'all'}));
  assert.equal(h.replies.at(-1).result.length,1);
  await h.ctx.handle(h.event('vault-ticket',{kind:'delete',id:'boarding'}));
  assert.equal(h.ctx.current().tickets.boarding,undefined);
  assert.equal(h.saves,2);
});

test('unauthorized origin, source and token cannot modify private data',async()=>{
  const h=harness();
  await h.ctx.handle({...h.event('vault-storage',{key:'dubai-days-personal-v1',value:'secret'}),origin:'https://attacker.example'});
  await h.ctx.handle({...h.event('vault-storage',{key:'dubai-days-personal-v1',value:'secret'}),origin:'https://example.test'});
  await h.ctx.handle({...h.event('vault-storage',{key:'dubai-days-personal-v1',value:'secret'}),source:{}});
  await h.ctx.handle(h.event('vault-storage',{key:'dubai-days-personal-v1',value:'secret',token:'wrong'}));
  assert.deepEqual(Object.keys(h.ctx.current().storage),[]);
  assert.equal(h.saves,0);
});

test('invalid ticket identifiers and oversized attachments are rejected',async()=>{
  const h=harness();
  await h.ctx.handle(h.event('vault-ticket',{kind:'put',id:'__proto__',record:{blob:new Blob(['x'])}}));
  assert.match(h.replies.at(-1).error,/идентификатор/);
  await h.ctx.handle(h.event('vault-ticket',{kind:'put',id:'huge',record:{blob:new Blob([new Uint8Array(6*1024*1024+1)])}}));
  assert.match(h.replies.at(-1).error,/вложение/);
  assert.equal(h.saves,0);
});

test('failed encrypted save returns error to iframe',async()=>{
  const h=harness();h.failSave(true);
  await h.ctx.handle(h.event('vault-ticket',{kind:'put',id:'ticket',record:{name:'small.pdf',type:'application/pdf',blob:new Blob(['test'])}}));
  assert.match(h.replies.at(-1).error,/Disk full/);
  assert.equal(h.ctx.current().tickets.ticket,undefined);
});

test('failed ticket deletion restores the in-memory ticket',async()=>{
  const h=harness();
  await h.ctx.handle(h.event('vault-ticket',{kind:'put',id:'ticket',record:{name:'ticket.pdf',type:'application/pdf',blob:new Blob(['ok'])}}));
  h.failSave(true);
  await h.ctx.handle(h.event('vault-ticket',{kind:'delete',id:'ticket'}));
  assert.match(h.replies.at(-1).error,/Disk full/);
  assert.equal(h.ctx.current().tickets.ticket.name,'ticket.pdf');
});

test('geolocation is proxied only for the active opaque-origin frame',async()=>{
  const h=harness();
  await h.ctx.handle(h.event('vault-geolocation'));
  assert.equal(h.replies.at(-1).type,'vault-geolocation-response');
  assert.equal(h.replies.at(-1).coords.latitude,25.2);
  assert.equal(h.replies.at(-1).coords.longitude,55.3);
  const before=h.replies.length;
  await h.ctx.handle({...h.event('vault-geolocation'),source:{}});
  assert.equal(h.replies.length,before);
});
