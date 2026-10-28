// Browser acceptance test: runs only against a fresh, temporary local origin.
// Uses signed synthetic data; never loads the private travel itinerary.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=fileURLToPath(new URL('../public/',import.meta.url));
const fixture=fileURLToPath(new URL('./fixtures/signed-synthetic.json',import.meta.url));
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
let browser;
try{
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  for(const width of [320,375,390,768,1280]){
    const context=await browser.newContext({viewport:{width,height:820},reducedMotion:'reduce'});
    const page=await context.newPage();
    await page.goto(url);
    await page.locator('#importFile').waitFor({state:'attached'});
    const metrics=await page.evaluate(()=>({body:document.body.scrollWidth,viewport:document.documentElement.clientWidth}));
    assert.ok(metrics.body<=metrics.viewport+1,`Horizontal overflow at ${width}px: ${JSON.stringify(metrics)}`);
    assert.equal(await page.locator('#importForm').isVisible(),true,`First-run form hidden at ${width}px`);
    if(width===390){
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
      await page.locator('#lockVault').click();
      await page.locator('#unlockPassword').fill('BrowserQaPassword-2026!');
      await page.locator('#unlockButton').click();
      await page.locator('#running').waitFor({state:'visible',timeout:30000});
      await page.reload();
      await page.locator('#unlockPassword').fill('BrowserQaPassword-2026!');
      await page.locator('#unlockButton').click();
      await page.locator('#running').waitFor({state:'visible',timeout:30000});
      console.log('PASS signed import, sandbox, lock/unlock and reload persistence');
    }
    console.log(`PASS responsive Chromium viewport ${width}px`);
    await context.close();
  }
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
