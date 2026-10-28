// Cache only the generic unlock screen. Never cache a user's imported bundle.
const CACHE='dubai-days-private-shell-v1';
const SHELL=['./','./index.html','./vault.css','./vault.js'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE&&key.startsWith('dubai-days-')).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  const url=new URL(event.request.url),scope=new URL(self.registration.scope);
  if(!url.pathname.startsWith(scope.pathname)||!['/','/index.html','/vault.css','/vault.js'].some(suffix=>url.pathname===scope.pathname.replace(/\/$/,'')+suffix))return;
  event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy))}return response}).catch(()=>caches.match(event.request)));
});
