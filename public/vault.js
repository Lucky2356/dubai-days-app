// Public shell. The original itinerary and application assets are NEVER
// fetched from GitHub Pages; they come from a user-supplied private bundle.
const DB_NAME='dubai-days-encrypted-vault-v1';
const FORMAT='dubai-days-private-import-v1';
const PASSWORD_MIN=12;
const ITERATIONS=310000;
const $=id=>document.getElementById(id);
let encryptedRecord=null,session=null,sessionKey=null,sessionToken=null;
let persistQueue=Promise.resolve(),persistQueued=false,lastPersistError=null;
const encoder=new TextEncoder(),decoder=new TextDecoder();

function openDB(){return new Promise((resolve,reject)=>{
  const request=indexedDB.open(DB_NAME,1);
  request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('records'))request.result.createObjectStore('records')};
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(Error('Хранилище браузера недоступно. Проверьте режим приватного просмотра.'));
})}
async function database(op,value){const db=await openDB();return new Promise((resolve,reject)=>{
  const tx=db.transaction('records',op==='get'?'readonly':'readwrite'),store=tx.objectStore('records');
  const request=op==='get'?store.get('encrypted'):store.put(value,'encrypted');
  let result;
  request.onsuccess=()=>{result=request.result};
  tx.oncomplete=()=>{db.close();resolve(result)};
  tx.onerror=tx.onabort=()=>{db.close();reject(Error('Не удалось сохранить защищённые данные на устройстве.'))};
})}
const base64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(text)};
const unbase64=value=>Uint8Array.from(atob(value),ch=>ch.charCodeAt(0));
async function keyFromPassword(password,salt){
  const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:ITERATIONS,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function encryptValue(value,key,salt){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode(JSON.stringify(value)));
  return {format:'dubai-days-locked-v1',iterations:ITERATIONS,salt:base64(salt),iv:base64(iv),ciphertext:base64(new Uint8Array(ciphertext))};
}
async function decryptValue(record,key){
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(record.iv)},key,unbase64(record.ciphertext));
  return JSON.parse(decoder.decode(plaintext));
}
function status(message,ok=false){const node=$('vaultStatus');node.textContent=message;node.classList.toggle('ok',ok)}
function formMode(mode){
  const updating=!!encryptedRecord;
  $('unlockForm').hidden=mode!=='unlock';$('importForm').hidden=mode!=='import';$('restoreForm').hidden=mode!=='restore';
  $('importNewPasswords').hidden=updating;$('importExistingPassword').hidden=!updating;
  $('importPassword').required=!updating;$('importConfirm').required=!updating;$('updatePassword').required=updating;
  $('switchToImport').hidden=mode==='import';$('switchToRestore').hidden=mode==='restore';
  $('switchToUnlock').hidden=mode==='unlock'||!encryptedRecord;
  const titles={unlock:'Открыть путеводитель',import:updating?'Обновить путеводитель':'Загрузить личный маршрут',restore:'Восстановить из копии'};
  $('accessTitle').textContent=titles[mode]||titles.unlock;
  const explainers={
    unlock:'Введите свой пароль. Маршрут и все изменения уже зашифрованы на этом устройстве.',
    import:updating?'Выберите обновлённый JSON и введите текущий пароль. Отметки, расходы и сохранённые билеты останутся на месте.':'Выберите личный JSON-файл и задайте пароль. Только зашифрованная копия останется в браузере.',
    restore:'Выберите защищённую резервную копию и введите её пароль. Восстановятся маршрут, отметки, расходы и билеты.'
  };
  $('vaultExplainer').textContent=explainers[mode]||explainers.unlock;
  $('importButton').textContent=updating?'Обновить без потери данных →':'Зашифровать и открыть →';
  status('');
}
function validateBundle(data){
  if(data?.format!==FORMAT||!Number.isInteger(data.version)||data.version<48||!data.html?.includes('id="appScreen"')||!Array.isArray(data.data?.trip?.days)||data.data.trip.days.length!==8)throw Error('Это не подходящий файл личного путеводителя.');
  const expected=['content.js','companion.js','travel-logic.js','app.js','route-focus.js','offline-atlas.js','travel-tools.js'];
  if(expected.some(name=>typeof data.scripts?.[name]!=='string')||typeof data.styles?.['styles.css']!=='string'||typeof data.assets?.hero!=='string'||typeof data.assets?.emergencyPdf!=='string')throw Error('В файле отсутствуют компоненты путеводителя.');
  return data;
}
function sameStages(previous,next){
  const a=previous.data.trip.days,b=next.data.trip.days;
  return a.length===b.length&&a.every((day,i)=>day.date===b[i]?.date&&day.legs.length===b[i]?.legs.length&&day.legs.every((leg,j)=>{
    const other=b[i].legs[j];return leg.mode===other.mode&&leg.from===other.from&&leg.to===other.to;
  }));
}
function validateProtectedRecord(value){
  if(value?.format!=='dubai-days-locked-v1'||value.iterations!==ITERATIONS||
     ![value.salt,value.iv,value.ciphertext].every(v=>typeof v==='string'&&v.length>12&&/^[A-Za-z0-9+/=]+$/.test(v)))
    throw Error('Это не зашифрованная копия Dubai Days.');
  return value;
}
const privateKeyName=key=>/^dubai-days-(?:personal|companion|hub|manual-checks|home-mode|weather)-v1$/.test(key);
function findLegacyStorage(){
  const result={};
  try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(privateKeyName(key)){const value=localStorage.getItem(key);if(value!==null)result[key]=value}}}catch{}
  return result;
}
async function findLegacyTickets(){
  try{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('dubai-days-local-tickets');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
    if(!db.objectStoreNames.contains('files')){db.close();return {}}
    const rows=await new Promise((resolve,reject)=>{const tx=db.transaction('files','readonly'),req=tx.objectStore('files').getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error)});db.close();
    const result={};for(const item of rows){if(item?.id&&item.blob instanceof Blob&&item.blob.size<=6*1024*1024)result[item.id]={id:item.id,name:item.name,type:item.type,body:base64(new Uint8Array(await item.blob.arrayBuffer())),savedAt:item.savedAt}}
    return result;
  }catch{return {}}
}
async function clearLegacy(legacyStorage,legacyTickets){
  try{for(const [key,value] of Object.entries(legacyStorage))if(localStorage.getItem(key)===value)localStorage.removeItem(key)}catch{}
  if(Object.keys(legacyTickets).length)try{
    const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('dubai-days-local-tickets');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
    if(db.objectStoreNames.contains('files'))await new Promise((resolve,reject)=>{const tx=db.transaction('files','readwrite');for(const id of Object.keys(legacyTickets))tx.objectStore('files').delete(id);tx.oncomplete=resolve;tx.onerror=reject});db.close();
  }catch{status('Некоторые старые незашифрованные вложения не удалось удалить. Проверьте данные браузера.')}
  try{
    const names=await caches.keys();
    // Keep every version of the protected shell. The service worker retires
    // outdated shell caches after its replacement is installed.
    await Promise.all(names.filter(name=>name.startsWith('dubai-days-')&&!name.startsWith('dubai-days-private-shell-')).map(name=>caches.delete(name)));
  }catch{}
  try{
    const currentScript=new URL('./sw.js',location.href).href;
    const registrations=await navigator.serviceWorker?.getRegistrations?.()||[];
    await Promise.all(registrations.filter(r=>r.active?.scriptURL!==currentScript&&r.active?.scriptURL?.endsWith('/sw.js')).map(r=>r.unregister()));
  }catch{}
}

function showSaveWarning(error){
  $('running').dataset.saveError=error?'true':'false';
  $('saveWarning').hidden=!error;
}
function schedulePersist(){
  if(!session||!sessionKey||!encryptedRecord||persistQueued)return;
  persistQueued=true;
  // A microtask starts the encrypted write immediately after the current
  // click/input handler, instead of leaving a 150 ms unsaved window.
  queueMicrotask(()=>{if(!persistQueued)return;persistQueued=false;enqueuePersist()});
}
function enqueuePersist(){
  if(!session||!sessionKey||!encryptedRecord)return persistQueue;
  const snapshot={bundle:session.bundle,storage:{...session.storage},tickets:{...(session.tickets||{})},maptilerKey:session.maptilerKey||''};
  const secret=sessionKey,salt=unbase64(encryptedRecord.salt);
  persistQueue=persistQueue.then(async()=>{
    const update=await encryptValue(snapshot,secret,salt);
    await database('put',update);encryptedRecord=update;lastPersistError=null;showSaveWarning(null);
  }).catch(error=>{lastPersistError=error;console.error('Encrypted save failed',error);showSaveWarning(error)});
  return persistQueue;
}
async function flush(){
  if(persistQueued){persistQueued=false;enqueuePersist()}
  await persistQueue;
  if(lastPersistError)throw lastPersistError;
}
const jsLiteral=value=>JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
const safeInline=(source,tag)=>source.replace(new RegExp('</'+tag,'gi'),'<\\/'+tag);
const asScript=source=>'<script>'+safeInline(source,'script')+'<\/script>';
const unpackExports=source=>source.replace(/^export\s+/gm,'');

function buildPrivateHTML(bundle,storage,token,maptilerKey=''){
  let html=bundle.html;
  const hero='data:image/webp;base64,'+bundle.assets.hero;
  const styles=Object.values(bundle.styles).map(css=>css.replace(/url\(['"]?\.\/assets\/dubai-hero\.webp['"]?\)/g,'url("'+hero+'")')).join('\n');
  html=html.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="\.\/[^>]*>/g,'');
  html=html.replace(/<script\b[^>]*src="\.\/[^>]*><\/script>/g,'');
  html=html.replace(/<link\b[^>]*rel="(?:icon|manifest)"[^>]*>/g,'');
  const rootUrl=location.href.replace(/(?:vault-shell\/)?(?:index\.html)?(?:[?#].*)?$/,'');
  const head='<base href="'+rootUrl+'"><style>'+safeInline(styles,'style')+'</style>';
  html=html.replace('</head>',head+'</head>');
  const prelude=`\nwindow.DUBAI_MAP_CONFIG=${jsLiteral({maptilerKey})};\nwindow.__vaultData=${jsLiteral(bundle.data)};\nwindow.__vaultStorageData=${jsLiteral(storage)};\nwindow.__vaultToken=${jsLiteral(token)};\nwindow.__vaultLocalStorage={getItem(key){return Object.prototype.hasOwnProperty.call(window.__vaultStorageData,key)?window.__vaultStorageData[key]:null},setItem(key,value){window.__vaultStorageData[key]=String(value);parent.postMessage({type:'vault-storage',token:window.__vaultToken,key,value:String(value)},'*')},removeItem(key){delete window.__vaultStorageData[key];parent.postMessage({type:'vault-storage',token:window.__vaultToken,key,value:null},'*')}};\nconst oldFetch=window.fetch.bind(window);window.fetch=(resource,options)=>{const url=typeof resource==='string'?resource:'';if(/(?:^|\\/)data\\/(?:trip|geometry)\\.json(?:[?#]|$)/.test(url)){const key=url.includes('trip.json')?'trip':'geometry';return Promise.resolve(new Response(JSON.stringify(window.__vaultData[key]),{status:200,headers:{'Content-Type':'application/json'}}))}return oldFetch(resource,options)};\nlet vaultSequence=0;const pendingTickets=new Map();window.addEventListener('message',event=>{const m=event.data;if(m?.type!=='vault-ticket-response'||m.token!==window.__vaultToken)return;const request=pendingTickets.get(m.requestId);if(!request)return;pendingTickets.delete(m.requestId);m.error?request.reject(Error(m.error)):request.resolve(m.result)});window.__vaultTicketOp=(kind,id,record)=>new Promise((resolve,reject)=>{const requestId=++vaultSequence;pendingTickets.set(requestId,{resolve,reject});parent.postMessage({type:'vault-ticket',token:window.__vaultToken,requestId,kind,id,record},'*')});\n`;
  const content=unpackExports(bundle.scripts['content.js']);
  const companion=unpackExports(bundle.scripts['companion.js']);
  const logic=unpackExports(bundle.scripts['travel-logic.js']);
  const define=asScript(prelude)+asScript('window.__content=(()=>{'+content+';return {FOOD,SHOPS,EXTRAS,BOOKINGS,TIPS,CATEGORIES}})();')+
    asScript('window.__companion=(()=>{'+companion+';return {distanceKm,nearestLeg,dailyBudget,weatherDescription,offlineMapSvg,bookingIcs}})();')+
    asScript('window.__logic=(()=>{'+logic+';return {preferredTripContext,clockWithDay,analyzePlanB,weightedDailyBudget,spendingByDay,calendarForStages,extraRecommendations,validateImportedBundle,TRIP_START_UTC}})();');
  let app=bundle.scripts['app.js'].replace(/^import\s+.*?;\s*$/gm,'');
  app=app.replace("if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});",'');
  app=app.replace('./assets/dubai-emergency-card.pdf','data:application/pdf;base64,'+bundle.assets.emergencyPdf);
  const appHead='const localStorage=window.__vaultLocalStorage;const {FOOD,SHOPS,EXTRAS,BOOKINGS,TIPS,CATEGORIES}=window.__content;const {distanceKm,nearestLeg,dailyBudget,weatherDescription,offlineMapSvg,bookingIcs}=window.__companion;';
  let tools=bundle.scripts['travel-tools.js'].replace(/^import\s+.*?;\s*$/gm,'');
  const ticketFunction=/async function ticketDB\(\)\{[^\n]*\}\nasync function ticketOp\(kind,id,record\)\{[^\n]*\}/;
  if(!ticketFunction.test(tools))throw Error('Ticket storage adapter does not match the private-app version');
  tools=tools.replace(ticketFunction,'async function ticketOp(kind,id,record){return window.__vaultTicketOp(kind,id,record)}');
  const toolsHead='const localStorage=window.__vaultLocalStorage;const {BOOKINGS,EXTRAS}=window.__content;const {offlineMapSvg}=window.__companion;const {preferredTripContext,clockWithDay,analyzePlanB,weightedDailyBudget,spendingByDay,calendarForStages,extraRecommendations,validateImportedBundle,TRIP_START_UTC}=window.__logic;';
  const main=asScript('(function(){'+appHead+app+'\n})();')+asScript('(function(){'+bundle.scripts['route-focus.js']+'\n})();')+asScript('(function(){'+bundle.scripts['offline-atlas.js']+'\n})();')+asScript('(function(){'+toolsHead+tools+'\n})();');
  return html.replace('</body>',define+main+'</body>');
}

async function lock(){
  try{await flush()}catch{return}
  $('privateFrame').srcdoc='';$('running').hidden=true;$('vaultGate').hidden=false;
  session=null;sessionKey=null;sessionToken=null;
  $('unlockPassword').value='';$('importPassword').value='';$('importConfirm').value='';$('updatePassword').value='';$('importFile').value='';
  formMode(encryptedRecord?'unlock':'import');
}
function unlockFrame(){
  sessionToken=base64(crypto.getRandomValues(new Uint8Array(18)));
  const html=buildPrivateHTML(session.bundle,session.storage,sessionToken,session.maptilerKey||'');
  $('privateFrame').srcdoc=html;
  $('vaultGate').hidden=true;$('running').hidden=false;
}
async function handleUnlock(event){
  event.preventDefault();const pass=$('unlockPassword').value,button=$('unlockButton');
  button.disabled=true;status('Расшифровываем данные…');
  try{
    sessionKey=await keyFromPassword(pass,unbase64(encryptedRecord.salt));
    session=await decryptValue(encryptedRecord,sessionKey);
    validateBundle(session.bundle);unlockFrame();
  }catch(error){session=null;sessionKey=null;status('Не удалось открыть. Проверьте пароль или состояние хранилища.')}
  finally{button.disabled=false}
}
async function handleImport(event){
  event.preventDefault();
  const updating=!!encryptedRecord,pass=$(updating?'updatePassword':'importPassword').value,confirmPass=$('importConfirm').value;
  const button=$('importButton'),file=$('importFile').files?.[0];
  if(!file||file.size>8*1024*1024){status('Выберите JSON-файл размером не более 8 МБ.');return}
  if(pass.length<PASSWORD_MIN||!updating&&pass!==confirmPass){status(updating?'Введите действующий пароль от путеводителя.':'Пароли должны совпадать и содержать не менее 12 символов.');return}
  button.disabled=true;status(updating?'Проверяем обновление и сохраняем ваши данные…':'Проверяем и шифруем ваш маршрут…');
  try{
    await flush();
    const bundle=validateBundle(JSON.parse(await file.text()));
    const salt=updating?unbase64(encryptedRecord.salt):crypto.getRandomValues(new Uint8Array(16));
    const key=await keyFromPassword(pass,salt);
    let nextSession,legacyStorage={},legacyTickets={};
    if(updating){
      let oldSession;
      try{oldSession=await decryptValue(encryptedRecord,key)}
      catch{throw Error('Текущий пароль неверный. Сохранённый путеводитель не изменён.')}
      validateBundle(oldSession.bundle);
      if(!sameStages(oldSession.bundle,bundle))
        throw Error('В JSON изменился состав или порядок этапов. Обновление отменено, чтобы не потерять отметки. Сначала скачайте защищённую копию.');
      nextSession={...oldSession,bundle};
    }else{
      legacyStorage=findLegacyStorage();legacyTickets=await findLegacyTickets();
      nextSession={bundle,storage:legacyStorage,tickets:legacyTickets};
    }
    // Check that the generated iframe is compatible before replacing the
    // only encrypted copy of the traveller's current itinerary.
    buildPrivateHTML(bundle,nextSession.storage,'validation-token',nextSession.maptilerKey||'');
    const record=await encryptValue(nextSession,key,salt);
    await database('put',record);
    encryptedRecord=record;session=nextSession;sessionKey=key;
    if(!updating)await clearLegacy(legacyStorage,legacyTickets);
    $('updatePassword').value='';
    unlockFrame();
  }catch(error){status(error?.message||'Не удалось импортировать файл. Данные не изменены.')}
  finally{button.disabled=false}
}

async function handleRestore(event){
  event.preventDefault();
  const file=$('restoreFile').files?.[0],pass=$('restorePassword').value,button=$('restoreButton');
  if(!file||file.size>64*1024*1024||pass.length<PASSWORD_MIN){status('Выберите защищённую копию не более 64 МБ и введите её пароль.');return}
  button.disabled=true;status('Проверяем резервную копию…');
  try{
    const record=validateProtectedRecord(JSON.parse(await file.text()));
    const key=await keyFromPassword(pass,unbase64(record.salt));
    let restored;
    try{restored=await decryptValue(record,key)}
    catch{throw Error('Неверный пароль или повреждённая резервная копия.')}
    validateBundle(restored.bundle);
    buildPrivateHTML(restored.bundle,restored.storage,'validation-token',restored.maptilerKey||'');
    if(encryptedRecord&&!confirm('Восстановить копию вместо текущего путеводителя на этом устройстве? Текущие данные будут заменены.')){status('Восстановление отменено.');return}
    await flush();await database('put',record);
    encryptedRecord=record;session=restored;sessionKey=key;
    $('restorePassword').value='';$('restoreFile').value='';
    unlockFrame();
  }catch(error){status(error?.message||'Восстановление не удалось. Текущие данные не изменены.')}
  finally{button.disabled=false}
}

async function exportProtectedBackup(){
  if(!session)return;
  try{
    await flush();
    const blob=new Blob([JSON.stringify({...encryptedRecord,exportedAt:new Date().toISOString()})],{type:'application/json'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download='dubai-days-protected-'+new Date().toISOString().slice(0,10)+'.json';
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }catch{alert('Не удалось скачать резервную копию. Проверьте, разрешены ли загрузки и доступны ли данные браузера.')}
}

async function handleVaultMessage(event){
  const m=event.data;
  if(!session||!sessionToken||event.source!==$('privateFrame').contentWindow||m?.token!==sessionToken)return;
  if(m.type==='vault-storage'){
    if(!privateKeyName(m.key)||typeof m.value!=='string'&&m.value!==null)return;
    if(m.value===null)delete session.storage[m.key];else session.storage[m.key]=m.value.slice(0,2*1024*1024);
    schedulePersist();return;
  }
  if(m.type!=='vault-ticket'||!Number.isInteger(m.requestId))return;
  let result=null,error=null;
  try{
    const list=session.tickets||={};
    if(m.kind==='put'){
      if(!m.record?.blob||typeof m.record.blob.arrayBuffer!=='function'||m.record.blob.size>6*1024*1024||!m.id)throw Error('Некорректное вложение');
      list[m.id]={id:m.id,name:String(m.record.name||'Билет').slice(0,120),type:m.record.type,body:base64(new Uint8Array(await m.record.blob.arrayBuffer())),savedAt:m.record.savedAt};
      schedulePersist();await flush();
    }else if(m.kind==='delete'){delete list[m.id];schedulePersist();await flush()}
    else if(m.kind==='get'){const item=list[m.id];result=item?{...item,blob:new Blob([unbase64(item.body)],{type:item.type})}:undefined}
    else if(m.kind==='all'){result=Object.values(list).map(item=>({...item,blob:new Blob([unbase64(item.body)],{type:item.type})}))}
    else throw Error('Неизвестная операция');
  }catch(e){error=e.message||'Ошибка сохранения файла'}
  event.source.postMessage({type:'vault-ticket-response',token:sessionToken,requestId:m.requestId,result,error},'*');
}

window.addEventListener('message',handleVaultMessage);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')void flush().catch(()=>{})});
window.addEventListener('pagehide',()=>{void flush().catch(()=>{})});
document.querySelectorAll('[data-toggle-password]').forEach(button=>button.addEventListener('click',()=>{const input=$(button.dataset.togglePassword);input.type=input.type==='password'?'text':'password';button.setAttribute('aria-label',input.type==='password'?'Показать пароль':'Скрыть пароль')}));
$('unlockForm').addEventListener('submit',handleUnlock);
$('importForm').addEventListener('submit',handleImport);
$('restoreForm').addEventListener('submit',handleRestore);
$('switchToImport').addEventListener('click',()=>formMode('import'));
$('switchToRestore').addEventListener('click',()=>formMode('restore'));
$('switchToUnlock').addEventListener('click',()=>formMode('unlock'));
$('lockVault').addEventListener('click',lock);
// The optional MapTiler browser key stays in the encrypted local session.
$('mapSettings').addEventListener('click',()=>{
  if(!session)return;
  $('maptilerKey').value=session.maptilerKey||'';
  $('mapSettingsDialog').showModal();
});
$('cancelMapSettings').addEventListener('click',()=>$('mapSettingsDialog').close());
$('exportVault').addEventListener('click',exportProtectedBackup);
$('updateVault').addEventListener('click',async()=>{
  $('mapSettingsDialog').close();
  await lock();
  if($('running').hidden)formMode('import');
});
$('mapSettingsForm').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!session)return;
  const button=$('saveMapSettings'),previous=session.maptilerKey||'';
  button.disabled=true;
  session.maptilerKey=$('maptilerKey').value.trim();
  try{
    schedulePersist();await flush();
    $('mapSettingsDialog').close();unlockFrame();
  }catch{
    session.maptilerKey=previous;
    $('mapSettingsDialog').close();
  }finally{button.disabled=false}
});
$('retrySave').addEventListener('click',()=>{schedulePersist();flush().catch(()=>{})});
try{
  if(!crypto?.subtle||!window.indexedDB)throw Error('Для защиты нужен современный браузер и HTTPS.');
  encryptedRecord=await database('get');
  formMode(encryptedRecord?'unlock':'import');
  navigator.serviceWorker?.register?.('./sw.js').catch(()=>{});
}catch(error){status(error.message||'Не удалось открыть защищённое хранилище.')}
