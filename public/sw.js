// Cache only the generic unlock screen. Never cache a user's imported bundle.
const CACHE='dubai-days-private-shell-v17';
const SHELL=['./','./index.html','./vault.css?v=17','./vault.js?v=17','./vault-crypto.js?v=17','./vault-pwa.js?v=17','./manifest.webmanifest','./icon.svg','./icon-192.png','./icon-512.png'];
function isShellResponse(response,requestUrl){
  return response.ok&&!response.redirected&&new URL(response.url).origin===self.location.origin&&new URL(response.url).pathname===new URL(requestUrl).pathname;
}
self.addEventListener('install',event=>{event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  for(const path of SHELL){
    const url=new URL(path,self.registration.scope);
    const response=await fetch(url.href,{cache:'no-store'});
    if(!isShellResponse(response,url.href))throw Error('Shell resource unavailable: '+path);
    await cache.put(url.href,response);
  }
  if(!self.registration.active)await self.skipWaiting();
})())});
self.addEventListener('message',event=>{if(event.data?.type==='APPLY_UPDATE')self.skipWaiting()});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE&&key.startsWith('dubai-days-')).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  const url=new URL(event.request.url),scope=new URL(self.registration.scope);
  if(!url.pathname.startsWith(scope.pathname)||!['/','/index.html','/vault.css','/vault.js','/vault-crypto.js','/vault-pwa.js','/manifest.webmanifest','/icon.svg','/icon-192.png','/icon-512.png'].some(suffix=>url.pathname===scope.pathname.replace(/\/$/,'')+suffix))return;
  event.respondWith(fetch(event.request).then(response=>{
    if(isShellResponse(response,event.request.url)){
      const copy=response.clone();
      event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)));
    }
    return response;
  }).catch(()=>caches.match(event.request)));
});
