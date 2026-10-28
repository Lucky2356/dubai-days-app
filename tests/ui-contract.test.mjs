import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const js=readFileSync(new URL('../public/vault.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/vault.css',import.meta.url),'utf8');
const worker=readFileSync(new URL('../public/sw.js',import.meta.url),'utf8');

test('UI elements referenced by scripts exist exactly once',()=>{
  const ids=[...html.matchAll(/\bid="([A-Za-z][\w-]*)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length,'Duplicate HTML IDs');
  const referenced=[...js.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)].map(m=>m[1]);
  assert.deepEqual([...new Set(referenced)].filter(id=>!ids.includes(id)),[]);
});

test('required inputs, update feedback and backup result have accessible names',()=>{
  for(const id of ['importFile','importPassword','importConfirm','restoreFile','restorePassword','verifyBackupFile','verifyBackupPassword'])
    assert.match(html,new RegExp(`<label[^>]+for="${id}"`));
  for(const id of ['vaultStatus','saveState','updateNotice','verifyBackupResult'])
    assert.match(html,new RegExp(`id="${id}"[^>]*(?:role="status"|aria-live="polite")`));
});

test('import requires explicit acknowledgement of executable source',()=>{
  assert.match(html,/id="trustedImport"[^>]*required/);
  assert.match(html,/id="importPreview"[^>]*aria-live="polite"/);
  assert.match(js,/if\(!\$\('trustedImport'\)\.checked\)/);
});

test('mobile, keyboard and reduced-motion accommodations are present',()=>{
  assert.match(css,/:focus-visible/);
  assert.match(css,/@media\(max-width:820px\)/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css,/safe-area-inset-bottom/);
});

test('PWA precaches the same current version and every imported module',()=>{
  for(const file of ['vault.css','vault.js','vault-crypto.js','vault-pwa.js']){
    assert.match(worker,new RegExp(file.replaceAll('.','\\.')+'\\?v=15'));
  }
  assert.match(html,/vault\.js\?v=15/);
  assert.match(js,/vault-crypto\.js\?v=15/);
  assert.match(js,/vault-pwa\.js\?v=15/);
});
