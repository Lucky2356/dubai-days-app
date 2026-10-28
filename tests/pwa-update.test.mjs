import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');
function worker({active,offline=false,redirect=false}={}){
  const handlers=new Map(),saved=new Map(),names=new Set();
  let skips=0,claims=0;
  const cache={put:async(req,res)=>saved.set(typeof req==='string'?req:req.url,res)};
  const context={
    self:{registration:{active,scope:'https://example.test/dubai-days-app/'},location:{origin:'https://example.test'},skipWaiting:async()=>{skips++},clients:{claim:async()=>{claims++}},addEventListener:(n,fn)=>handlers.set(n,fn)},
    caches:{open:async name=>{names.add(name);return cache},keys:async()=>[...names],delete:async name=>names.delete(name),match:async req=>saved.get(typeof req==='string'?req:req.url)},
    URL,
    fetch:async req=>{if(offline)throw Error('offline');const url=typeof req==='string'?req:req.url;return {ok:true,redirected:redirect,url:redirect?'https://example.test/signin':url,clone(){return this}}},
  };
  vm.runInNewContext(source,context);
  async function event(name,data){const pending=[];let response;handlers.get(name)({data,request:data,waitUntil:p=>pending.push(p),respondWith:p=>{response=p}});const result=response?await response:undefined;await Promise.all(pending);return result}
  return {event,saved,names,get skips(){return skips},get claims(){return claims}};
}
test('first installation activates',async()=>{const sw=worker({active:null});await sw.event('install');assert.equal(sw.skips,1);assert.equal(sw.saved.size,6)});
test('upgrade waits for explicit confirmation',async()=>{const sw=worker({active:{}});await sw.event('install');assert.equal(sw.skips,0);await sw.event('message',{type:'UNRELATED'});assert.equal(sw.skips,0);await sw.event('message',{type:'APPLY_UPDATE'});assert.equal(sw.skips,1)});
test('activation removes previous shell only',async()=>{const sw=worker({active:{}});sw.names.add('dubai-days-private-shell-v11');sw.names.add('other-cache');await sw.event('install');await sw.event('activate');assert.deepEqual([...sw.names].sort(),['dubai-days-private-shell-v12','other-cache']);assert.equal(sw.claims,1)});
test('offline request returns cached application asset',async()=>{const sw=worker({active:{},offline:true});const req={url:'https://example.test/dubai-days-app/vault.js?v=12',method:'GET'};const cached={body:'offline'};sw.saved.set(req.url,cached);assert.equal(await sw.event('fetch',req),cached)});
test('redirected login page never enters cache',async()=>{const sw=worker({active:{},redirect:true});await assert.rejects(sw.event('install'),/Shell resource unavailable/);assert.equal(sw.saved.size,0)});
test('successful fetch waits for cache write',async()=>{const sw=worker({active:{}});const req={url:'https://example.test/dubai-days-app/vault.js?v=12',method:'GET'};await sw.event('fetch',req);assert.ok(sw.saved.has(req.url))});
