import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/vault.js',import.meta.url),'utf8');
const ctx={location:{href:'https://example.test/dubai-days-app/'},JSON,URL,console};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('const jsLiteral='),source.indexOf('async function lock('))+'\nthis.render=buildPrivateHTML;',ctx);
function bundle(version=50){return {
  version,html:'<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body><div id="appScreen"></div><script src="./app.js"></script></body></html>',
  assets:{hero:'AAAA',emergencyPdf:'BBBB'},data:{trip:{days:[]},geometry:{}},
  styles:{'styles.css':'body{background:url(./assets/dubai-hero.webp)}'},
  scripts:{'content.js':'','companion.js':'','travel-logic.js':'','app.js':'','route-focus.js':'','offline-atlas.js':'','travel-tools.js':'async function ticketDB(){return null}\nasync function ticketOp(kind,id,record){return null}'},
}}

test('private renderer removes network assets and injects local data adapters',()=>{
  const html=ctx.render(bundle(),{notes:'offline'},'test-token');
  assert.match(html,/data:image\/webp;base64,AAAA/);
  assert.match(html,/window\.__vaultLocalStorage/);
  assert.match(html,/window\.__vaultTicketOp/);
  assert.match(html,/window\.__vaultToken="test-token"/);
  assert.doesNotMatch(html,/<script src="\.\/app\.js"><\/script>/);
  assert.doesNotMatch(html,/<link rel="stylesheet" href="\.\/styles\.css">/);
  assert.match(html,/async function ticketOp\(kind,id,record\)\{return window\.__vaultTicketOp/);
});

test('renderer escapes unsafe script delimiters in embedded storage',()=>{
  const html=ctx.render(bundle(),{notes:'</script><script>alert(1)</script>'},'test-token');
  assert.doesNotMatch(html,/window\.__vaultStorageData=\{[^\n]*<\/script>/);
  assert.match(html,/\\u003c\/script>/);
});

test('legacy v48 route includes mobile readability fallback',()=>{
  const html=ctx.render(bundle(48),{},'test-token');
  assert.match(html,/max-width:830px/);
  assert.match(html,/min-height:44px/);
});
