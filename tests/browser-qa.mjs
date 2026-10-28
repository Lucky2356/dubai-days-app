// Browser acceptance test: runs only against a fresh, temporary local origin.
// Uses signed synthetic data; never loads the private travel itinerary.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,firefox,webkit} from 'playwright';
import axe from 'axe-core';

const root=fileURLToPath(new URL('../public/',import.meta.url));
const fixture=fileURLToPath(new URL('./fixtures/signed-synthetic.json',import.meta.url));
const compressedStressFixture=fileURLToPath(new URL('./fixtures/signed-stress.json.gz',import.meta.url));
const engine=process.env.DUBAI_QA_ENGINE||'chromium';
const browserTypes={chromium,firefox,webkit};
if(!Object.hasOwn(browserTypes,engine))throw Error(`Unsupported QA browser: ${engine}`);
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const server=createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const target=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!target.startsWith(root.endsWith(sep)?root:root+sep)){res.writeHead(403).end();return}
    const body=await readFile(target);
    res.writeHead(200,{'Content-Type':mime[extname(target)]||'application/octet-stream','Cache-Control':'no-store'}).end(body);
  }catch{res.writeHead(404).end()}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
async function auditAccessibility(page,label){
  await page.addScriptTag({content:axe.source});
  const results=await page.evaluate(()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']}}));
  const severe=results.violations.filter(item=>['critical','serious'].includes(item.impact));
  assert.deepEqual(severe.map(v=>`${v.id}: ${v.nodes.map(n=>n.target.join(',')).join(';')}`),[],`Accessibility violations: ${label}`);
  console.log(`PASS accessibility ${label} (${results.passes.length} rules)`);
}
let browser;
try{
  browser=await browserTypes[engine].launch({headless:true,...(engine==='chromium'?{args:['--no-sandbox']}:{})});
  for(const width of [320,375,390,768,1280]){
    const context=await browser.newContext({viewport:{width,height:820},reducedMotion:'reduce'});
    const page=await context.newPage();
    await page.goto(url);
    await page.locator('#importFile').waitFor({state:'attached'});
    const metrics=await page.evaluate(()=>({body:document.body.scrollWidth,viewport:document.documentElement.clientWidth}));
    assert.ok(metrics.body<=metrics.viewport+1,`Horizontal overflow at ${width}px: ${JSON.stringify(metrics)}`);
    assert.equal(await page.locator('#importForm').isVisible(),true,`First-run form hidden at ${width}px`);
    if(width===390){
      await auditAccessibility(page,'first run');
      const fcp=await page.evaluate(()=>performance.getEntriesByType('paint').find(entry=>entry.name==='first-contentful-paint')?.startTime||null);
      console.log(`INFO ${engine} first contentful paint ${fcp?.toFixed(1)??'unavailable'} ms (CI measurement, not a speed guarantee)`);
      if(fcp!==null)assert.ok(fcp<5000,`Public shell first contentful paint exceeded 5s: ${fcp} ms`);
      await page.locator('#importFile').setInputFiles(fixture);
      await page.locator('#importPreview').getByText('Цифровая подпись подтверждена',{exact:false}).waitFor({timeout:15000});
      await page.locator('#importPassword').fill('BrowserQaPassword-2026!');
      await page.locator('#importConfirm').fill('BrowserQaPassword-2026!');
      await page.locator('#trustedImport').check();
      await page.locator('#importButton').click();
      await page.locator('#running').waitFor({state:'visible',timeout:30000}).catch(async error=>{
        throw Error(`${error.message}\nImport status: ${await page.locator('#vaultStatus').innerText()}`);
      });
      const frame=page.frameLocator('#privateFrame');
      await frame.locator('#appScreen').waitFor({state:'attached',timeout:10000});
      assert.equal(await page.locator('#privateFrame').getAttribute('sandbox').then(x=>x.includes('allow-same-origin')),false);
      await page.locator('#quickTrip').click();
      await page.locator('#quickTripDialog').waitFor({state:'visible'});
      assert.match(await page.locator('#quickDestination').innerText(),/Свободное время/);
      await page.locator('#quickTripClose').click();
      await page.locator('#emergencyOpen').click();
      await page.locator('#emergencyDialog').waitFor({state:'visible'});
      assert.match(await page.locator('#emergencyDialog').innerText(),/999[\s\S]*998[\s\S]*997/);
      await page.locator('#emergencyClose').click();
      await auditAccessibility(page,'unlocked shell');
      // A synthetic expense marker exercises the same encrypted local storage bridge.
      await frame.locator('#appScreen').evaluate(()=>window.__vaultLocalStorage.setItem('dubai-days-personal-v1',JSON.stringify({lastDay:2,progress:{2:1},expenses:[{note:'browser-qa-marker',aed:7}]})));
      await page.waitForFunction(()=>document.querySelector('#saveState')?.textContent?.includes('Сохранено'));
      await page.locator('#mapSettings').click();
      const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#exportVault').click()]);
      const backup=await readFile(await download.path());
      await page.locator('.vault-verify summary').click();
      await page.locator('#verifyBackupFile').setInputFiles({name:'qa-backup.json',mimeType:'application/json',buffer:backup});
      await page.locator('#verifyBackupPassword').fill('BrowserQaPassword-2026!');
      await page.locator('#verifyBackup').click();
      await page.locator('#verifyBackupResult').getByText('Копия проверена',{exact:false}).waitFor({timeout:15000});
      await page.locator('#closeVaultSettings').click();
      await page.locator('#lockVault').click();
      await page.locator('#unlockPassword').fill('BrowserQaPassword-2026!');
      await page.locator('#unlockButton').click();
      await page.locator('#running').waitFor({state:'visible',timeout:30000});
      await page.reload();
      await page.locator('#unlockPassword').fill('BrowserQaPassword-2026!');
      await page.locator('#unlockButton').click();
      await page.locator('#running').waitFor({state:'visible',timeout:30000});
      // The service worker must serve the shell while the browser has no network.
      await page.evaluate(async()=>{await navigator.serviceWorker.ready});
      await page.reload();
      await page.locator('#unlockPassword').fill('BrowserQaPassword-2026!');
      await page.locator('#unlockButton').click();
      await page.locator('#running').waitFor({state:'visible',timeout:30000});
      if(engine==='webkit'){
        // Linux WebKit + Playwright blocks all offline navigation via Web
        // Inspector, including service-worker responses. Check cache integrity
        // here; offline navigation itself remains an explicitly unverified case.
        const cached=await page.evaluate(async()=>{
          const cache=await caches.open('dubai-days-private-shell-v20');
          const files=['./','./vault.js?v=20','./vault-crypto.js?v=20','./vault-pwa.js?v=20','./vault-trust.js?v=20'];
          return Promise.all(files.map(async file=>Boolean(await cache.match(new URL(file,location.href)))));
        });
        assert.deepEqual(cached,[true,true,true,true,true]);
        console.log('PASS webkit service-worker cache integrity; offline navigation needs a real Safari environment');
      }else{
        await context.setOffline(true);
        await page.reload({waitUntil:'domcontentloaded'});
        await page.locator('#unlockPassword').fill('BrowserQaPassword-2026!');
        await page.locator('#unlockButton').click();
        await page.locator('#running').waitFor({state:'visible',timeout:30000});
        await context.setOffline(false);
        console.log(`PASS ${engine} offline reload and unlocking from IndexedDB`);
      }
      console.log('PASS signed import, sandbox, lock/unlock and reload persistence');
      const restoreContext=await browser.newContext({viewport:{width:390,height:820},acceptDownloads:true});
      const restored=await restoreContext.newPage();await restored.goto(url);
      await restored.locator('#switchToRestore').click();
      await restored.locator('#restoreFile').setInputFiles({name:'qa-backup.json',mimeType:'application/json',buffer:backup});
      await restored.locator('#restorePassword').fill('BrowserQaPassword-2026!');
      await restored.locator('#restoreButton').click();
      await restored.locator('#running').waitFor({state:'visible',timeout:30000}).catch(async error=>{throw Error(`${error.message}\nRestore status: ${await restored.locator('#vaultStatus').innerText()}`)});
      const restoredValue=await restored.frameLocator('#privateFrame').locator('#appScreen').evaluate(()=>window.__vaultLocalStorage.getItem('dubai-days-personal-v1'));
      assert.match(restoredValue,/browser-qa-marker/);
      await restoreContext.close();
      console.log('PASS backup export, integrity verification and restore in fresh browser context');
      const loadContext=await browser.newContext({viewport:{width:390,height:820}});
      const loaded=await loadContext.newPage();await loaded.goto(url);
      const loadStart=Date.now();
      await loaded.locator('#importFile').setInputFiles({name:'signed-stress.json',mimeType:'application/json',buffer:gunzipSync(await readFile(compressedStressFixture))});
      await loaded.locator('#importPreview').getByText('Цифровая подпись подтверждена',{exact:false}).waitFor({timeout:20000});
      await loaded.locator('#importPassword').fill('StressQaPassword-2026!');
      await loaded.locator('#importConfirm').fill('StressQaPassword-2026!');
      await loaded.locator('#trustedImport').check();
      await loaded.locator('#importButton').click();
      await loaded.locator('#running').waitFor({state:'visible',timeout:30000}).catch(async error=>{throw Error(`${error.message}\nStress import: ${await loaded.locator('#vaultStatus').innerText()}`)});
      const elapsed=Date.now()-loadStart;
      assert.ok(elapsed<25000,`Stress bundle import exceeded 25s: ${elapsed}ms`);
      console.log(`PASS ${engine} 695 KB signed synthetic stress bundle, 61 stages, encrypted in ${elapsed} ms`);
      await loadContext.close();
    }
    console.log(`PASS ${engine} responsive viewport ${width}px`);
    await context.close();
  }
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
