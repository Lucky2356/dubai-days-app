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
    assert.match(worker,new RegExp(file.replaceAll('.','\\.')+'\\?v=18'));
  }
  assert.match(html,/vault\.js\?v=18/);
  assert.match(js,/vault-crypto\.js\?v=18/);
  assert.match(js,/vault-pwa\.js\?v=18/);
});

test('first-run file selection supports drag and drop without bypassing checks',()=>{
  assert.match(html,/id="importDropZone"/);
  assert.match(js,/importFile'\)\.dispatchEvent\(new Event\('change'/);
  assert.match(js,/const info=summarizeBundle\(data\)/);
  assert.match(js,/\$\('trustedImport'\)\.checked=false/);
  assert.match(css,/\.file-picker\.drag-active/);
});

test('password feedback is accessible and never weakens the minimum',()=>{
  assert.match(html,/id="passwordGuidance"[^>]*role="status"/);
  assert.match(html,/id="importPassword"[^>]*minlength="12"/);
  assert.match(html,/id="importConfirm"[^>]*minlength="12"/);
  assert.match(js,/function updatePasswordGuidance\(/);
  assert.match(js,/pass\.length<PASSWORD_MIN|password\.length<PASSWORD_MIN/);
});

test('low-visibility captions meet WCAG AA contrast on their backgrounds',()=>{
  const relativeLuminance=hex=>{
    const channels=hex.slice(1).match(/../g).map(part=>parseInt(part,16)/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);
    return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
  };
  const contrast=(front,back)=>{
    const a=relativeLuminance(front),b=relativeLuminance(back);
    return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  };
  for(const [selector,background] of [['.brand small','#f5f8f4'],['.card-header small','#ffffff'],['.vault-layout footer','#f5f8f4'],['.info p','#f5f8f4'],['.file-picker-name','#ffffff'],['.drop-hint','#f1f9f2']]){
    const escaped=selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const match=css.match(new RegExp(`${escaped}\\{[^}]*color:(#[0-9a-f]{6})`));
    assert.ok(match,`Color for ${selector}`);
    assert.ok(contrast(match[1],background)>=4.5,`${selector} contrast: ${contrast(match[1],background).toFixed(2)}`);
  }
});

test('optional web font never blocks first paint',()=>{
  assert.match(html,/fonts\.googleapis\.com[^"']+" rel="stylesheet" media="print" onload=/);
  assert.match(html,/<noscript><link rel="stylesheet"/);
});
