import {base64,unbase64,keyFromPassword,encryptValue,decryptValue} from './vault-crypto.js?v=23';
import {initPwaUpdates} from './vault-pwa.js?v=23';
import {verifyBundleTrust} from './vault-trust.js?v=23';
import {initTravelExtras,quickStagesForDay} from './vault-extras.js?v=23';
// Public shell. The original itinerary and application assets are NEVER
// fetched from GitHub Pages; they come from a user-supplied private bundle.
const DB_NAME='dubai-days-encrypted-vault-v1';
const FORMAT='dubai-days-private-import-v1';
const PASSWORD_MIN=12;
const ITERATIONS=310000;
// Keep the encrypted export safely below the restore size limit on phones.
const MAX_TICKET_BASE64=40*1024*1024;
const MAX_RESTORE_BYTES=128*1024*1024; // Also accept older, larger backups.
const $=id=>document.getElementById(id);
let encryptedRecord=null,session=null,sessionKey=null,sessionToken=null;
let persistQueue=Promise.resolve(),persistQueued=false,lastPersistError=null;
let travelExtrasView=null;

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
function status(message,ok=false){const node=$('vaultStatus');node.textContent=message;node.classList.toggle('ok',ok)}
function setSaveState(message,mode='ok'){
  const node=$('saveState');if(!node)return;
  node.textContent=message;node.dataset.mode=mode;
}
function refreshBackupReminder(){
  const saved=Date.parse(session?.lastBackupAt||'');
  const due=!Number.isFinite(saved)||saved>Date.now()||Date.now()-saved>30*86400000;
  const shown=Date.parse(session?.lastBackupPromptAt||'');
  $('backupPrompt').hidden=!(due&&(!Number.isFinite(shown)||shown>Date.now()||Date.now()-shown>30*86400000));
  $('mapSettings').title='Настройки и резервная копия';
}
function acknowledgeBackupPrompt(){
  if(!session)return;
  session.lastBackupPromptAt=new Date().toISOString();
  $('backupPrompt').hidden=true;
  schedulePersist();
}
function formMode(mode){
  const updating=!!encryptedRecord;
  $('onboardingSteps').hidden=mode!=='import'||updating;
  $('unlockForm').hidden=mode!=='unlock';$('importForm').hidden=mode!=='import';$('restoreForm').hidden=mode!=='restore';
  $('importNewPasswords').hidden=updating;$('importExistingPassword').hidden=!updating;
  $('importPassword').required=!updating;$('importConfirm').required=!updating;$('updatePassword').required=updating;
  $('switchToImport').hidden=mode==='import';$('switchToRestore').hidden=mode==='restore';
  $('switchToUnlock').hidden=mode==='unlock'||!encryptedRecord;
  const titles={unlock:'Открыть путеводитель',import:updating?'Обновить путеводитель':'Загрузить личный маршрут',restore:'Восстановить из копии'};
  $('accessTitle').textContent=titles[mode]||titles.unlock;
  const explainers={
    unlock:'Введите свой пароль. Маршрут и все изменения уже зашифрованы на этом устройстве.',
    import:updating?'Выберите обновлённый файл Dubai Days и введите текущий пароль. Отметки и билеты сохранятся, даже если этапы переставлены внутри дня.':'Выберите полученный файл Dubai Days. Это нужно сделать один раз — затем для входа понадобится только пароль.',
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
  // Trip text goes through several dynamic templates in legacy bundles.
  // Fail closed on markup and executable URL schemes in imported data.
  const pending=[data.data.trip,data.data.geometry];let inspected=0;
  while(pending.length){
    const value=pending.pop();if(++inspected>200000)throw Error('Данные маршрута слишком велики.');
    if(typeof value==='string'&&/[<>]|(?:javascript|vbscript|data:text\/html)\s*:/i.test(value))throw Error('В данных маршрута найден небезопасный HTML или адрес.');
    if(value&&typeof value==='object')pending.push(...Object.values(value));
  }
  // Import bundles are executable applications. Reject executable HTML that
  // is absent from the known build layout; never present arbitrary JSON as safe.
  const scripts=[...data.html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if(scripts.length!==(data.html.match(/<script\b/gi)||[]).length||scripts.some(([,attributes,body])=>body.trim()||!/\bsrc=["']\.\/[\w/-]+\.js(?:\?[\w=&.-]+)?["']/i.test(attributes))||/<(?:iframe|object|embed)\b|\s+on[a-z]{3,}\s*=|javascript\s*:/i.test(data.html))throw Error('Файл содержит неподдерживаемый HTML-код. Загружайте только файл Dubai Days из доверенного источника.');
  return data;
}
function summarizeBundle(data){
  const bundle=validateBundle(data);
  return {days:bundle.data.trip.days.length,stages:bundle.data.trip.days.reduce((count,day)=>count+(Array.isArray(day.legs)?day.legs.length:0),0),version:bundle.version};
}
function sameStages(previous,next){
  const a=previous.data.trip.days,b=next.data.trip.days;
  return a.length===b.length&&a.every((day,i)=>day.date===b[i]?.date&&day.legs.length===b[i]?.legs.length&&day.legs.every((leg,j)=>{
    const other=b[i].legs[j];return leg.mode===other.mode&&leg.from===other.from&&leg.to===other.to;
  }));
}
function stageMapping(previous,next){
  const a=previous.data.trip.days,b=next.data.trip.days;
  if(a.length!==b.length)throw Error('В JSON изменилось количество дней. Прежний путеводитель сохранён.');
  return a.map((day,d)=>{
    const other=b[d];
    if(day.date!==other?.date||!Array.isArray(day.legs)||!Array.isArray(other.legs)||day.legs.length!==other.legs.length)
      throw Error('В JSON изменился состав дней или этапов. Обновление отменено во избежание потери отметок.');
    const key=leg=>JSON.stringify([leg?.mode,leg?.from,leg?.to]);
    const old=day.legs.map(key),fresh=other.legs.map(key);
    if(old.every((value,i)=>value===fresh[i]))return old.map((_,i)=>i);
    if(new Set(old).size!==old.length||new Set(fresh).size!==fresh.length)
      throw Error('Повторяющиеся этапы невозможно безопасно сопоставить. Обновление отменено.');
    const mapping=old.map(value=>fresh.indexOf(value));
    if(mapping.includes(-1))throw Error('В JSON добавлены или удалены этапы. Обновление отменено для защиты отметок.');
    return mapping;
  });
}
function remapStageStorage(source,mapping){
  const storage={...(source||{})};
  if(mapping.every(indexes=>indexes.every((next,i)=>next===i)))return storage;
  const reindex=(day,value)=>{
    const index=Number(value),replacement=mapping[day]?.[index];
    if(!Number.isInteger(index)||!Number.isInteger(replacement))throw Error('В сохранённых отметках есть неизвестный этап. Обновление отменено.');
    return replacement;
  };
  const remapSet=value=>{
    if(value===undefined)return value;
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Неверный формат сохранённых этапов. Обновление отменено.');
    return Object.fromEntries(Object.entries(value).map(([day,indexes])=>{
      if(!Array.isArray(indexes))throw Error('Не удалось перенести отмеченные этапы.');
      return [day,indexes.map(index=>reindex(day,index))];
    }));
  };
  const personal='dubai-days-personal-v1',companion='dubai-days-companion-v1';
  try{
    if(storage[personal]){
      const saved=JSON.parse(storage[personal]);
      if(!saved||typeof saved!=='object'||Array.isArray(saved))throw Error();
      saved.completed=remapSet(saved.completed);
      if(saved.progress)saved.progress=Object.fromEntries(Object.entries(saved.progress).map(([day,index])=>[day,reindex(day,index)]));
      if(saved.undo&&Number.isInteger(saved.undo.step))saved.undo.step=reindex(saved.undo.day,saved.undo.step);
      storage[personal]=JSON.stringify(saved);
    }
    if(storage[companion]){
      const saved=JSON.parse(storage[companion]);
      if(!saved||typeof saved!=='object'||Array.isArray(saved))throw Error();
      saved.skipped=remapSet(saved.skipped);saved.deferred=remapSet(saved.deferred);
      storage[companion]=JSON.stringify(saved);
    }
  }catch{throw Error('Не удалось безопасно перенести сохранённый прогресс. Скачайте защищённую копию перед обновлением.')}
  return storage;
}
function remapTravelExtras(extras,mapping){
  if(extras==null)return extras;
  if(typeof extras!=='object'||Array.isArray(extras))throw Error('Не удалось перенести дополнительные данные путешествия. Обновление отменено.');
  const plans=extras.plans||{};
  if(typeof plans!=='object'||Array.isArray(plans))throw Error('Неверный формат альтернативных планов. Обновление отменено.');
  const migrated={};
  for(const [day,plan] of Object.entries(plans)){
    if(!plan||typeof plan!=='object'||!Array.isArray(plan.skip))throw Error('Не удалось перенести пропуски этапов. Обновление отменено.');
    const indexes=mapping[Number(day)];
    if(!indexes)throw Error('В сохранённом плане обнаружен неизвестный день. Обновление отменено.');
    migrated[day]={...plan,skip:plan.skip.map(value=>{
      const index=Number(value),next=indexes[index];
      if(!Number.isInteger(index)||!Number.isInteger(next))throw Error('В сохранённом плане есть неизвестный этап. Обновление отменено.');
      return next;
    })};
  }
  return {...extras,plans:migrated};
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
  if(error)setSaveState('! Не сохранено','error');
}
function schedulePersist(){
  if(!session||!sessionKey||!encryptedRecord||persistQueued)return;
  persistQueued=true;
  setSaveState('Сохраняем…','pending');
  // A microtask starts the encrypted write immediately after the current
  // click/input handler, instead of leaving a 150 ms unsaved window.
  queueMicrotask(()=>{if(!persistQueued)return;persistQueued=false;enqueuePersist()});
}
function enqueuePersist(){
  if(!session||!sessionKey||!encryptedRecord)return persistQueue;
  const snapshot={bundle:session.bundle,storage:{...session.storage},tickets:{...(session.tickets||{})},maptilerKey:session.maptilerKey||'',lastBackupAt:session.lastBackupAt||'',lastBackupVerifiedAt:session.lastBackupVerifiedAt||'',lastBackupPromptAt:session.lastBackupPromptAt||'',travelExtras:session.travelExtras||null};
  const secret=sessionKey,salt=unbase64(encryptedRecord.salt);
  persistQueue=persistQueue.then(async()=>{
    const update=await encryptValue(snapshot,secret,salt);
    await database('put',update);encryptedRecord=update;lastPersistError=null;showSaveWarning(null);setSaveState('✓ Сохранено');
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
// RTA's JavaScript timetable may render as a blank page in some browsers.
// Apply the verified static-document links to already imported v48/v49
// itineraries at unlock time, so users do not need to re-import private data.
const abraPDF='https://www.rta.ae/links/marine/rta-abra-routes.pdf';
const abraStation='https://www.rta.ae/links/promotions/en/jaddaf.html';
const oldTimetable=/https:\/\/(?:www\.)?rta\.ae\/wps\/portal\/rta\/ae\/public-transport\/timetable(?:\?lang=en)?/g;
const oldJaddaf=/https:\/\/(?:www\.)?rta\.ae\/wps\/portal\/rta\/ae\/home\/promotion\/jeddaf-abra(?:\?lang=en)?/g;
const repairMarineURL=(text,promoReplacement=abraPDF)=>text.replace(oldTimetable,abraPDF).replace(oldJaddaf,promoReplacement);

function optimizeLegacyMap(app,tools){
  // Already-imported v48/v49 itineraries receive shorter failovers without
  // reimporting the private JSON or touching any saved progress and tickets.
  app=app.replace('mapLoadTimeout=setTimeout(()=>{if(!loaded)next()},7000);','mapLoadTimeout=setTimeout(()=>{if(!loaded)next()},4500);')
    .replace('const timeout=setTimeout(()=>finish(false),9000);','const timeout=setTimeout(()=>finish(false),6500);')
    .replace('},9500);','},5500);')
    .replace('const vectorReady=!useCompactRaster&&canUseWebGLMap()?await loadVectorLibrary():false;',
      'const vectorReady=!useCompactRaster&&!!MAPTILER_STREETS_STYLE&&canUseWebGLMap()?await loadVectorLibrary():false;')
    .replace('activateVectorStyle(container,MAPTILER_STREETS_STYLE||FALLBACK_VECTOR_STYLE,{allowFreeFallback:Boolean(MAPTILER_STREETS_STYLE)});',
      'activateVectorStyle(container,MAPTILER_STREETS_STYLE||FALLBACK_VECTOR_STYLE,{allowFreeFallback:false});');
  tools=tools.replace('},12000);','},6500);').replace('},8500);','},4500);');
  return {app,tools};
}

function unifyPrivateBackups(app,tools){
  // Older private JSONs contain multiple incompatible backup formats, one of
  // which exports expense notes in plaintext. Adapt them at unlock time so
  // existing travellers receive one protected backup without reimporting.
  if(app.includes('function backupPanel()')){
    const panel=/^function backupPanel\(\)\{return .*$/m;
    if(!panel.test(app))throw Error('Устаревший формат панели копирования. Обновите личный JSON.');
    app=app.replace(panel,`function backupPanel(){return '<section class="backup-panel"><h3>🔐 Защищённая копия</h3><p>Весь маршрут, расходы и билеты можно сохранить одним зашифрованным файлом. Он откроется только с вашим паролем.</p><div><button type="button" data-vault-backup>Открыть настройки и резервную копию →</button></div></section>'}`);
    app=app.replace(/^function backupPayload\(\)\{.*$/m,'function backupPayload(){throw Error("Незашифрованный экспорт отключён. Используйте защищённую копию.")}');
    app=app.replace(/^async function shareBackup\(\)\{[\s\S]*?^\}/m,'async function shareBackup(){window.__vaultShowSettings()}');
    app=app.replace(/^function exportBackup\(\)\{.*$/m,'function exportBackup(){window.__vaultShowSettings()}');
  }
  const oldTransfer='<button type="button" data-travel-tab="sync"><strong>⇄ Перенос данных</strong><span>Вручную, защищённым файлом</span></button>';
  if(tools.includes(oldTransfer))tools=tools.replace(oldTransfer,'<button type="button" data-vault-backup><strong>🔐 Защищённая копия</strong><span>Маршрут, расходы и билеты одним файлом</span></button>');
  const oldTicketCopy=/<div class="travel-ticket-backup">[\s\S]*?<\/div><input id="travel-ticket-backup-file"[^>]*><\/div>/;
  if(oldTicketCopy.test(tools))tools=tools.replace(oldTicketCopy,'<div class="travel-ticket-backup"><h4>Единая резервная копия</h4><p>Билеты теперь сохраняются вместе с маршрутом и расходами через настройки путеводителя.</p><button type="button" data-vault-backup>Открыть защищённую копию →</button></div>');
  return {app,tools};
}

function buildPrivateHTML(bundle,storage,token,maptilerKey=''){
  let html=bundle.html;
  const hero='data:image/webp;base64,'+bundle.assets.hero;
  // Keep already-encrypted v48 imports readable without forcing a destructive reimport.
  const legacyLegibility=bundle.styles['ux-v49.css']?'':`@media(max-width:830px){.screen :is(.map-caption,.map-toolbar p,.companion-current span,.date-button strong,.cover p,.freshness-checklist small,.heading-more p){font-size:13px!important;line-height:1.5}.screen :is(.stage-secondary>summary,.currency-converter small,.currency-converter label){font-size:13px!important}.screen :is(.stage-controls button,.map-toolbar .segmented button){min-height:44px;font-size:13px!important}.travel-hub-dialog :is(.travel-kicker,.travel-section-heading p,.travel-now-heading>span,.travel-map-offline>span){font-size:13px!important}.travel-hub-dialog :is(.travel-now-navigation button,.travel-map-links a,.travel-map-links button,.travel-map-scope button,.travel-tabs button){min-height:44px!important;font-size:13px!important}}@media(max-width:580px){.screen .companion-primary-actions>*{min-height:46px!important;font-size:14px!important}.screen .companion-quick-row button{min-height:44px!important;font-size:13px!important}}`;
  const styles=Object.values(bundle.styles).map(css=>css.replace(/url\(['"]?\.\/assets\/dubai-hero\.webp['"]?\)/g,'url("'+hero+'")')).join('\n')+'\n'+legacyLegibility;
  html=html.replace(/<link\b[^>]*rel="stylesheet"[^>]*href="\.\/[^>]*>/g,'');
  html=html.replace(/<script\b[^>]*src="\.\/[^>]*><\/script>/g,'');
  html=html.replace(/<link\b[^>]*rel="(?:icon|manifest)"[^>]*>/g,'');
  const rootUrl=location.href.replace(/(?:vault-shell\/)?(?:index\.html)?(?:[?#].*)?$/,'');
  const head='<base href="'+rootUrl+'"><style>'+safeInline(styles,'style')+'</style>';
  html=html.replace('</head>',head+'</head>');
  const repairedData=JSON.parse(repairMarineURL(JSON.stringify(bundle.data)));
  const prelude=`\nwindow.DUBAI_MAP_CONFIG=${jsLiteral({maptilerKey})};\nwindow.__vaultData=${jsLiteral(repairedData)};\nwindow.__vaultStorageData=${jsLiteral(storage)};\nwindow.__vaultToken=${jsLiteral(token)};\nwindow.__vaultLocalStorage={getItem(key){return Object.prototype.hasOwnProperty.call(window.__vaultStorageData,key)?window.__vaultStorageData[key]:null},setItem(key,value){window.__vaultStorageData[key]=String(value);parent.postMessage({type:'vault-storage',token:window.__vaultToken,key,value:String(value)},'*')},removeItem(key){delete window.__vaultStorageData[key];parent.postMessage({type:'vault-storage',token:window.__vaultToken,key,value:null},'*')}};\nconst oldFetch=window.fetch.bind(window);window.fetch=(resource,options)=>{const url=typeof resource==='string'?resource:'';if(/(?:^|\\/)data\\/(?:trip|geometry)\\.json(?:[?#]|$)/.test(url)){const key=url.includes('trip.json')?'trip':'geometry';return Promise.resolve(new Response(JSON.stringify(window.__vaultData[key]),{status:200,headers:{'Content-Type':'application/json'}}))}return oldFetch(resource,options)};\nlet vaultSequence=0;const pendingTickets=new Map();window.addEventListener('message',event=>{const m=event.data;if(event.source!==parent||m?.type!=='vault-ticket-response'||m.token!==window.__vaultToken)return;const request=pendingTickets.get(m.requestId);if(!request)return;pendingTickets.delete(m.requestId);m.error?request.reject(Error(m.error)):request.resolve(m.result)});window.__vaultTicketOp=(kind,id,record)=>new Promise((resolve,reject)=>{const requestId=++vaultSequence;pendingTickets.set(requestId,{resolve,reject});parent.postMessage({type:'vault-ticket',token:window.__vaultToken,requestId,kind,id,record},'*')});\n`;
  const content=repairMarineURL(unpackExports(bundle.scripts['content.js']),abraStation);
  const companion=unpackExports(bundle.scripts['companion.js']);
  const logic=unpackExports(bundle.scripts['travel-logic.js']);
  const protectedPrelude=prelude+`\nwindow.__vaultShowSettings=()=>parent.postMessage({type:'vault-show-settings',token:window.__vaultToken},'*');\ndocument.addEventListener('click',event=>{if(event.target.closest?.('[data-vault-backup]')){event.preventDefault();window.__vaultShowSettings()}},true);\nwindow.addEventListener('message',event=>{const m=event.data;if(event.source!==parent||m?.token!==window.__vaultToken||m?.type!=='vault-open-assistant')return;document.querySelector('[data-travel-hub]')?.click()});\nlet geoSequence=0;const pendingGeo=new Map();window.__vaultGetCurrentPosition=(success,error,options)=>{const requestId=++geoSequence;pendingGeo.set(requestId,{success,error});parent.postMessage({type:'vault-geolocation',token:window.__vaultToken,requestId},'*')};window.addEventListener('message',event=>{const m=event.data;if(event.source!==parent||m?.type!=='vault-geolocation-response'||m.token!==window.__vaultToken)return;const request=pendingGeo.get(m.requestId);if(!request)return;pendingGeo.delete(m.requestId);m.errorCode?request.error({code:m.errorCode}):request.success({coords:m.coords})});\n`;
  const define=asScript(protectedPrelude)+asScript('window.__content=(()=>{'+content+';return {FOOD,SHOPS,EXTRAS,BOOKINGS,TIPS,CATEGORIES}})();')+
    asScript('window.__companion=(()=>{'+companion+';return {distanceKm,nearestLeg,dailyBudget,weatherDescription,offlineMapSvg,bookingIcs}})();')+
    asScript('window.__logic=(()=>{'+logic+';return {preferredTripContext,clockWithDay,analyzePlanB,weightedDailyBudget,spendingByDay,calendarForStages,extraRecommendations,validateImportedBundle,TRIP_START_UTC}})();');
  let app=repairMarineURL(bundle.scripts['app.js']).replace(/^import\s+.*?;\s*$/gm,'');
  app=app.replace("if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});",'');
  // Sandbox has an opaque origin; ask the trusted parent for geolocation only
  // after the traveller explicitly clicks the existing "Find me" button.
  app=app.replace(/navigator\.geolocation\.getCurrentPosition\(/g,'window.__vaultGetCurrentPosition(');
  app=app.replace(/if\(!navigator\.geolocation\)/g,'if(!window.__vaultGetCurrentPosition)');
  app=app.replace('./assets/dubai-emergency-card.pdf','data:application/pdf;base64,'+bundle.assets.emergencyPdf);
  const appHead='const localStorage=window.__vaultLocalStorage;const {FOOD,SHOPS,EXTRAS,BOOKINGS,TIPS,CATEGORIES}=window.__content;const {distanceKm,nearestLeg,dailyBudget,weatherDescription,offlineMapSvg,bookingIcs}=window.__companion;';
  let tools=bundle.scripts['travel-tools.js'].replace(/^import\s+.*?;\s*$/gm,'');
  const ticketFunction=/async function ticketDB\(\)\{[^\n]*\}\nasync function ticketOp\(kind,id,record\)\{[^\n]*\}/;
  if(!ticketFunction.test(tools))throw Error('Ticket storage adapter does not match the private-app version');
  tools=tools.replace(ticketFunction,'async function ticketOp(kind,id,record){return window.__vaultTicketOp(kind,id,record)}');
  const toolsHead='const localStorage=window.__vaultLocalStorage;const {BOOKINGS,EXTRAS}=window.__content;const {offlineMapSvg}=window.__companion;const {preferredTripContext,clockWithDay,analyzePlanB,weightedDailyBudget,spendingByDay,calendarForStages,extraRecommendations,validateImportedBundle,TRIP_START_UTC}=window.__logic;';
  if(bundle.version<50)({app,tools}=optimizeLegacyMap(app,tools));
  ({app,tools}=unifyPrivateBackups(app,tools));
  const main=asScript('(function(){'+appHead+app+'\n})();')+asScript('(function(){'+bundle.scripts['route-focus.js']+'\n})();')+asScript('(function(){'+bundle.scripts['offline-atlas.js']+'\n})();')+asScript('(function(){'+toolsHead+tools+'\n})();');
  return html.replace('</body>',define+main+'</body>');
}

async function lock(){
  try{await flush()}catch{return}
  travelExtrasView?.close();
  for(const id of ['quickTripDialog','emergencyDialog'])if($(id).open)$(id).close();
  $('privateFrame').srcdoc='';$('running').hidden=true;$('vaultGate').hidden=false;
  session=null;sessionKey=null;sessionToken=null;
  $('unlockPassword').value='';$('importPassword').value='';$('importConfirm').value='';$('updatePassword').value='';$('importFile').value='';
  $('importFileName').textContent='Файл ещё не выбран';
  formMode(encryptedRecord?'unlock':'import');
}
function unlockFrame(){
  sessionToken=base64(crypto.getRandomValues(new Uint8Array(18)));
  const html=buildPrivateHTML(session.bundle,session.storage,sessionToken,session.maptilerKey||'');
  $('privateFrame').srcdoc=html;
  $('vaultGate').hidden=true;$('running').hidden=false;
  setSaveState('✓ Сохранено');
  refreshBackupReminder();
}
async function handleUnlock(event){
  event.preventDefault();const pass=$('unlockPassword').value,button=$('unlockButton');
  button.disabled=true;status('Расшифровываем данные…');
  try{
    sessionKey=await keyFromPassword(pass,unbase64(encryptedRecord.salt));
    session=await decryptValue(encryptedRecord,sessionKey);
    validateBundle(session.bundle);await verifyBundleTrust(session.bundle);unlockFrame();
  }catch(error){session=null;sessionKey=null;status(/(?:подпись|официальн|пакет)/i.test(error?.message||'')?error.message:'Не удалось открыть. Проверьте пароль или состояние хранилища.')}
  finally{button.disabled=false}
}
async function handleImport(event){
  event.preventDefault();
  if(!$('trustedImport').checked){status('Подтвердите, что доверяете источнику файла маршрута.');return}
  const updating=!!encryptedRecord,pass=$(updating?'updatePassword':'importPassword').value,confirmPass=$('importConfirm').value;
  const button=$('importButton'),file=$('importFile').files?.[0];
  if(!file||file.size>8*1024*1024){status('Выберите JSON-файл размером не более 8 МБ.');return}
  if(pass.length<PASSWORD_MIN||!updating&&pass!==confirmPass){status(updating?'Введите действующий пароль от путеводителя.':'Пароли должны совпадать и содержать не менее 12 символов.');return}
  button.disabled=true;status(updating?'Проверяем обновление и сохраняем ваши данные…':'Проверяем и шифруем ваш маршрут…');
  try{
    await flush();
    const bundle=validateBundle(JSON.parse(await file.text()));
    await verifyBundleTrust(bundle);
    const salt=updating?unbase64(encryptedRecord.salt):crypto.getRandomValues(new Uint8Array(16));
    const key=await keyFromPassword(pass,salt);
    let nextSession,legacyStorage={},legacyTickets={};
    if(updating){
      let oldSession;
      try{oldSession=await decryptValue(encryptedRecord,key)}
      catch{throw Error('Текущий пароль неверный. Сохранённый путеводитель не изменён.')}
      validateBundle(oldSession.bundle);await verifyBundleTrust(oldSession.bundle);
      const mapping=stageMapping(oldSession.bundle,bundle);
      nextSession={...oldSession,bundle,storage:remapStageStorage(oldSession.storage,mapping),travelExtras:remapTravelExtras(oldSession.travelExtras,mapping)};
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
    $('trustedImport').checked=false;
    unlockFrame();
  }catch(error){status(error?.message||'Не удалось импортировать файл. Данные не изменены.')}
  finally{button.disabled=false}
}

async function handleRestore(event){
  event.preventDefault();
  const file=$('restoreFile').files?.[0],pass=$('restorePassword').value,button=$('restoreButton');
  if(!file||file.size>MAX_RESTORE_BYTES||pass.length<PASSWORD_MIN){status('Выберите защищённую копию не более 128 МБ и введите её пароль.');return}
  button.disabled=true;status('Проверяем резервную копию…');
  try{
    const record=validateProtectedRecord(JSON.parse(await file.text()));
    const key=await keyFromPassword(pass,unbase64(record.salt));
    let restored;
    try{restored=await decryptValue(record,key)}
    catch{throw Error('Неверный пароль или повреждённая резервная копия.')}
    validateBundle(restored.bundle);await verifyBundleTrust(restored.bundle);
    buildPrivateHTML(restored.bundle,restored.storage,'validation-token',restored.maptilerKey||'');
    if(encryptedRecord&&!confirm('Восстановить копию вместо текущего путеводителя на этом устройстве? Текущие данные будут заменены.')){status('Восстановление отменено.');return}
    await flush();await database('put',record);
    encryptedRecord=record;session=restored;sessionKey=key;
    $('restorePassword').value='';$('restoreFile').value='';$('restoreFileName').textContent='Файл ещё не выбран';
    unlockFrame();
  }catch(error){status(error?.message||'Восстановление не удалось. Текущие данные не изменены.')}
  finally{button.disabled=false}
}

async function exportProtectedBackup(){
  if(!session)return;
  const previousDate=session.lastBackupAt||'';
  try{
    await flush();
    session.lastBackupAt=new Date().toISOString();schedulePersist();await flush();
    // Verify the exact ciphertext being offered for download is decryptable.
    const verified=await decryptValue(encryptedRecord,sessionKey);
    if(verified?.bundle?.format!==FORMAT||!verified.storage||!verified.tickets)throw Error('Backup verification failed');
    const blob=new Blob([JSON.stringify({...encryptedRecord,exportedAt:session.lastBackupAt})],{type:'application/json'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download='dubai-days-protected-'+new Date().toISOString().slice(0,10)+'.json';
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
    refreshBackupReminder();
    void refreshVaultHealth();
  }catch{session.lastBackupAt=previousDate;schedulePersist();void flush().catch(()=>{});alert('Не удалось скачать резервную копию. Проверьте, разрешены ли загрузки и доступны ли данные браузера.')}
}

async function inspectProtectedBackup(record,password){
  const safe=validateProtectedRecord(record);
  const key=await keyFromPassword(password,unbase64(safe.salt));
  const data=await decryptValue(safe,key);
  validateBundle(data?.bundle);await verifyBundleTrust(data.bundle);
  if(!data.storage||typeof data.storage!=='object'||Array.isArray(data.storage)||
     !data.tickets||typeof data.tickets!=='object'||Array.isArray(data.tickets))
    throw Error('В копии отсутствуют сохранённые данные или билеты.');
  return {days:data.bundle.data.trip.days.length,tickets:Object.keys(data.tickets).length};
}

async function verifyProtectedBackup(){
  const file=$('verifyBackupFile').files?.[0],password=$('verifyBackupPassword').value;
  const result=$('verifyBackupResult'),button=$('verifyBackup');
  if(!file||file.size>MAX_RESTORE_BYTES||password.length<PASSWORD_MIN){
    result.textContent='Выберите файл до 128 МБ и введите пароль длиной не менее 12 символов.';return;
  }
  button.disabled=true;result.textContent='Проверяем целостность зашифрованного файла…';
  try{
    const record=JSON.parse(await file.text()),summary=await inspectProtectedBackup(record,password);
    result.textContent=`✓ Копия проверена: ${summary.days} дней, билетов: ${summary.tickets}. Данные приложения не изменены.`;
    if(session&&record.ciphertext===encryptedRecord?.ciphertext){
      session.lastBackupVerifiedAt=new Date().toISOString();
      schedulePersist();await flush();void refreshVaultHealth();
    }
  }catch{result.textContent='Не удалось проверить копию: неверный пароль, повреждённый или несовместимый файл.'}
  finally{button.disabled=false;$('verifyBackupPassword').value=''}
}

function dateForUser(value){
  const timestamp=Date.parse(value||'');
  return Number.isFinite(timestamp)?new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(timestamp)):'неизвестна';
}
function readableSize(value){return Number.isFinite(value)?(value/1024/1024).toFixed(value>=1024*1024?1:2)+' МБ':'неизвестно'}
async function vaultStorageInfo(){
  let persisted=null,estimate=null,offlineReady=false;
  try{if(navigator.storage?.persisted)persisted=await navigator.storage.persisted()}catch{}
  try{if(navigator.storage?.estimate)estimate=await navigator.storage.estimate()}catch{}
  try{offlineReady=(await caches.keys()).includes('dubai-days-private-shell-v23')}catch{}
  return {persisted,estimate,offlineReady};
}
async function refreshVaultHealth(){
  if(!session)return;
  const verified=session.lastBackupVerifiedAt&&session.lastBackupAt&&Date.parse(session.lastBackupVerifiedAt)>=Date.parse(session.lastBackupAt);
  $('vaultBackupStatus').textContent=session.lastBackupAt?(verified?'✓ Проверенная копия: ':'Последняя подготовленная копия: ')+dateForUser(session.lastBackupAt)+(verified?'. Храните файл отдельно.':'. Проверьте файл в загрузках.'):'Вы ещё не скачивали защищённую копию на этом устройстве.';
  const {persisted,estimate}=await vaultStorageInfo();
  if(!session)return;
  const parts=[persisted===true?'Браузер закрепил данные':persisted===false?'Данные могут быть очищены браузером':'Статус закрепления недоступен'];
  if(Number.isFinite(estimate?.usage)&&Number.isFinite(estimate?.quota))parts.push('Использовано доменом: '+readableSize(estimate.usage)+' из примерно '+readableSize(estimate.quota));
  $('vaultStorageStatus').textContent=parts.join(' · ')+'. Ручная резервная копия всё равно нужна.';
  const button=$('persistVault');button.disabled=persisted===true||!navigator.storage?.persist;
  button.textContent=persisted===true?'✓ Хранение закреплено браузером':navigator.storage?.persist?'Защитить данные от автоматической очистки':'Браузер не поддерживает закрепление данных';
}
async function checkVaultReadiness(){
  if(!session)return;
  const {persisted,offlineReady}=await vaultStorageInfo();
  if(!session)return;
  const last=Date.parse(session.lastBackupAt||''),recent=Number.isFinite(last)&&Date.now()-last<30*86400000&&last<=Date.now();
  const files=Object.keys(session.tickets||{}).length;
  const checks=[
    {level:'ok',message:'Все '+(session.bundle?.data?.trip?.days?.length||0)+' дней маршрута доступны после разблокировки'},
    {level:lastPersistError?'fail':'ok',message:lastPersistError?'Есть ошибка сохранения — нажмите «Повторить» над путеводителем':'Последние изменения сохранены в зашифрованном виде'},
    {level:recent&&Date.parse(session.lastBackupVerifiedAt||'')>=last?'ok':'warn',message:recent?(Date.parse(session.lastBackupVerifiedAt||'')>=last?'Недавняя защищённая копия проверена: ':'Подготовленная копия ещё не проверена: ')+dateForUser(session.lastBackupAt):'Скачайте свежую защищённую копию перед поездкой'},
    {level:persisted?'ok':'warn',message:persisted?'Хранение закреплено браузером':'Закрепите хранилище, если браузер это позволяет'},
    {level:offlineReady?'ok':'warn',message:offlineReady?'Оболочка сайта сохранена для офлайн-входа':'Откройте сайт ещё раз с интернетом, чтобы подготовить офлайн-вход'},
    {level:'ok',message:'Прикреплено файлов билетов: '+files+'. Откройте нужные QR и PDF заранее'},
    {level:'warn',message:'Перед вылетом вручную перепроверьте расписания транспорта, цены и ссылки в разделе «Данные» маршрута'}
  ];
  if(Number.isFinite(window.innerWidth)&&window.innerWidth<=600){
    const overflows=document.documentElement.scrollWidth>window.innerWidth+1;
    checks.push({level:overflows?'fail':'ok',message:overflows?'На телефоне появилась горизонтальная прокрутка — сообщите об этом разработчику':'Ширина мобильного экрана подходит: горизонтальной прокрутки оболочки нет'});
  }
  const list=$('vaultChecks');list.replaceChildren();
  for(const check of checks){const li=document.createElement('li'),mark=document.createElement('span'),label=document.createElement('span');
    li.dataset.level=check.level;mark.className='vault-check-symbol';mark.textContent=check.level==='ok'?'✓':check.level==='fail'?'!':'•';label.textContent=check.message;li.append(mark,label);list.append(li)}
  list.hidden=false;
  await refreshVaultHealth();
}

async function handleVaultMessage(event){
  const m=event.data;
  if(!session||!sessionToken||event.origin!=='null'||event.source!==$('privateFrame').contentWindow||m?.token!==sessionToken)return;
  if(m.type==='vault-show-settings'){$('mapSettings').click();return}
  if(m.type==='vault-geolocation'){
    if(!Number.isInteger(m.requestId)||m.requestId<1)return;
    const reply=(coords,errorCode)=>{
      if(!session||event.source!==$('privateFrame').contentWindow||m.token!==sessionToken)return;
      event.source.postMessage({type:'vault-geolocation-response',token:sessionToken,requestId:m.requestId,coords,errorCode},'*');
    };
    if(!navigator.geolocation){reply(null,2);return}
    navigator.geolocation.getCurrentPosition(
      result=>reply({latitude:result.coords.latitude,longitude:result.coords.longitude,accuracy:result.coords.accuracy},null),
      error=>reply(null,error?.code||2),
      {enableHighAccuracy:false,timeout:12000,maximumAge:120000}
    );
    return;
  }
  if(m.type==='vault-storage'){
    if(!privateKeyName(m.key)||typeof m.value!=='string'&&m.value!==null)return;
    if(m.value!==null&&m.value.length>2*1024*1024){lastPersistError=Error('Сохранённые данные превышают допустимый размер.');showSaveWarning(lastPersistError);return}
    if(m.value===null)delete session.storage[m.key];else session.storage[m.key]=m.value;
    schedulePersist();return;
  }
  if(m.type!=='vault-ticket'||!Number.isInteger(m.requestId))return;
  let result=null,error=null;
  try{
    const list=session.tickets||={};
    if(m.kind!=='all'&&(typeof m.id!=='string'||!m.id||m.id.length>160||['__proto__','constructor','prototype'].includes(m.id)))throw Error('Некорректный идентификатор билета');
    if(m.kind==='put'){
      if(!m.record?.blob||typeof m.record.blob.arrayBuffer!=='function'||m.record.blob.size>6*1024*1024)throw Error('Некорректное вложение');
      if(!Object.hasOwn(list,m.id)&&Object.keys(list).length>=150)throw Error('Достигнут лимит сохранённых билетов. Скачайте резервную копию.');
      const occupied=Object.entries(list).reduce((total,[id,item])=>total+(id===m.id?0:String(item?.body||'').length),0);
      if(occupied+4*Math.ceil(m.record.blob.size/3)>MAX_TICKET_BASE64)throw Error('Общий размер вложений превышает 30 МБ. Удалите ненужные билеты, заранее сохранив оригиналы.');
      const previous=list[m.id],existed=Object.hasOwn(list,m.id);
      list[m.id]={id:m.id,name:String(m.record.name||'Билет').slice(0,120),type:m.record.type,body:base64(new Uint8Array(await m.record.blob.arrayBuffer())),savedAt:m.record.savedAt};
      try{schedulePersist();await flush()}catch(error){if(existed)list[m.id]=previous;else delete list[m.id];throw error}
    }else if(m.kind==='delete'){
      const previous=list[m.id],existed=Object.hasOwn(list,m.id);
      delete list[m.id];
      try{schedulePersist();await flush()}catch(error){if(existed)list[m.id]=previous;throw error}
    }
    else if(m.kind==='get'){const item=list[m.id];result=item?{...item,blob:new Blob([unbase64(item.body)],{type:item.type})}:undefined}
    else if(m.kind==='all'){result=Object.values(list).map(item=>({...item,blob:new Blob([unbase64(item.body)],{type:item.type})}))}
    else throw Error('Неизвестная операция');
  }catch(e){error=e.message||'Ошибка сохранения файла'}
  // Opaque-origin srcdoc frames require '*'; source and unguessable token
  // ensure the reply can only be associated with the active private frame.
  event.source.postMessage({type:'vault-ticket-response',token:sessionToken,requestId:m.requestId,result,error},'*');
}

window.addEventListener('message',handleVaultMessage);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')void flush().catch(()=>{})});
window.addEventListener('pagehide',()=>{void flush().catch(()=>{})});
document.querySelectorAll('[data-toggle-password]').forEach(button=>button.addEventListener('click',()=>{const input=$(button.dataset.togglePassword);input.type=input.type==='password'?'text':'password';button.setAttribute('aria-label',input.type==='password'?'Показать пароль':'Скрыть пароль')}));
function updatePasswordGuidance(){
  const password=$('importPassword').value,confirmation=$('importConfirm').value,node=$('passwordGuidance');
  node.dataset.mode=!password?'hint':password.length<PASSWORD_MIN?'warn':confirmation&&password!==confirmation?'warn':confirmation?'ok':'hint';
  node.textContent=!password?'Минимум 12 символов. Сохраните пароль отдельно: восстановить его нельзя.':
    password.length<PASSWORD_MIN?`Добавьте ещё ${PASSWORD_MIN-password.length} символов к паролю.`:
    confirmation&&password!==confirmation?'Пароли пока не совпадают.':confirmation?'✓ Пароли совпадают. Не забудьте сохранить пароль отдельно.':'Теперь повторите пароль для проверки.';
}
for(const id of ['importPassword','importConfirm'])$(id).addEventListener('input',updatePasswordGuidance);
const importDropZone=$('importDropZone');
for(const name of ['dragenter','dragover'])importDropZone.addEventListener(name,event=>{
  if(!Array.from(event.dataTransfer?.types||[]).includes('Files'))return;
  event.preventDefault();event.dataTransfer.dropEffect='copy';importDropZone.classList.add('drag-active');
});
for(const name of ['dragleave','drop'])importDropZone.addEventListener(name,event=>{
  importDropZone.classList.remove('drag-active');
  if(name!=='drop'||!event.dataTransfer?.files?.length)return;
  event.preventDefault();
  try{
    const chosen=event.dataTransfer.files[0],transfer=new DataTransfer();
    transfer.items.add(chosen);$('importFile').files=transfer.files;
    $('importFile').dispatchEvent(new Event('change',{bubbles:true}));
  }catch{ $('importPreview').textContent='Перетаскивание не поддерживается этим браузером. Нажмите «Выбрать файл маршрута».'; }
});
const filePreviewTokens={importFile:0,restoreFile:0};
for(const [inputId,labelId,previewId] of [['importFile','importFileName','importPreview'],['restoreFile','restoreFileName','restorePreview']]){
  $(inputId).addEventListener('change',async()=>{
    const file=$(inputId).files?.[0];
    if(inputId==='importFile')$('trustedImport').checked=false;
    $(labelId).textContent=file?file.name:'Файл ещё не выбран';
    const token=++filePreviewTokens[inputId],preview=$(previewId);
    preview.textContent='';if(!file)return;
    const max=inputId==='importFile'?8*1024*1024:MAX_RESTORE_BYTES;
    if(file.size>max){preview.textContent='Файл превышает допустимый размер.';return}
    if(inputId==='restoreFile'&&file.size>8*1024*1024){preview.textContent='Большая зашифрованная копия выбрана. Проверим её после ввода пароля.';return}
    preview.textContent='Проверяем формат файла…';
    try{
      const data=JSON.parse(await file.text());
      if(token!==filePreviewTokens[inputId])return;
      if(inputId==='importFile'){
        const info=summarizeBundle(data);
        const trust=await verifyBundleTrust(data);
        if(token!==filePreviewTokens[inputId])return;
        preview.textContent=`✓ ${trust==='signed'?'Цифровая подпись подтверждена':'Проверенный официальный пакет'}: ${info.days} дней, ${info.stages} этапов, версия ${info.version}. Для открытия потребуется пароль.`;
      }else{
        validateProtectedRecord(data);
        preview.textContent='✓ Формат зашифрованной копии распознан. Целостность проверится после ввода пароля.';
      }
    }catch(error){if(token===filePreviewTokens[inputId])preview.textContent='Этот файл не подходит: '+(error?.message||'неверный JSON')}
  });
}
// A small, offline-first view of the already-encrypted private itinerary.
// It neither guesses the traveller's GPS location nor changes trip progress.
function quickDays(){return session?.bundle?.data?.trip?.days||[]}
function quickRender(){
  const days=quickDays(),day=Math.min(days.length-1,Math.max(0,Number($('quickDay').value)||0));
  const stages=quickStagesForDay(days[day]),step=Math.max(0,Math.min(stages.length-1,Number($('quickStep').value)||0));
  $('quickStep').replaceChildren();
  stages.forEach((stage,index)=>{const option=new Option(`${index+1}. ${stage.title}`,String(index));$('quickStep').add(option)});
  if(stages.length)$('quickStep').value=String(step);
  const stage=stages[step];
  $('quickDestination').textContent=stage?.title||'Свободное время';
  $('quickTime').textContent=(days[day]?.date||'')+' · '+(stage?.time||'Время уточняйте по плану');
  $('quickHow').textContent=stage?.how||'На этот день больше нет запланированных этапов.';
  $('quickPrev').disabled=day===0&&step===0;
  $('quickNext').disabled=day===days.length-1&&step===stages.length-1;
  const list=$('quickDayList');list.replaceChildren();
  stages.forEach((item,index)=>{const li=document.createElement('li');li.textContent=`${item.time||'—'} · ${item.title}`;if(index===step)li.classList.add('current');list.append(li)});
}
function quickSelect(day,step){
  const days=quickDays();if(!days.length)return;
  $('quickDay').value=String(Math.max(0,Math.min(days.length-1,day)));
  $('quickStep').replaceChildren(new Option('Выбранный этап',String(Math.max(0,step))));quickRender();
}
$('quickTrip').addEventListener('click',()=>{
  if(!session)return;
  const days=quickDays(),selected=(()=>{try{return JSON.parse(session.storage?.['dubai-days-personal-v1']||'{}')}catch{return {}}})();
  const day=Number.isInteger(selected.lastDay)?Math.max(0,Math.min(days.length-1,selected.lastDay)):0;
  $('quickDay').replaceChildren();
  days.forEach((item,index)=>$('quickDay').add(new Option(`${index+1}. ${item.date}: ${item.title||'План дня'}`,String(index))));
  $('quickDay').value=String(day);
  const progress=selected.progress?.[day];
  $('quickStep').replaceChildren();$('quickStep').add(new Option('Текущий этап',String(Number.isInteger(progress)?progress:0)));
  quickRender();$('quickTripDialog').showModal();
});
$('quickDay').addEventListener('change',()=>quickSelect(Number($('quickDay').value),0));
$('quickStep').addEventListener('change',()=>{const value=$('quickStep').value;quickRender();$('quickStep').value=value});
for(const [id,direction] of [['quickPrev',-1],['quickNext',1]])$(id).addEventListener('click',()=>{
  const days=quickDays(),day=Number($('quickDay').value),step=Number($('quickStep').value)+direction;
  if(step<0)quickSelect(day-1,quickStagesForDay(days[day-1]).length-1||0);
  else if(step>=quickStagesForDay(days[day]).length)quickSelect(day+1,0);
  else quickSelect(day,step);
});
$('quickTripClose').addEventListener('click',()=>$('quickTripDialog').close());
$('quickAssistant').addEventListener('click',()=>{
  $('quickTripDialog').close();
  if(sessionToken)$('privateFrame').contentWindow?.postMessage({type:'vault-open-assistant',token:sessionToken},'*');
});
$('emergencyOpen').addEventListener('click',()=>{
  if(!session)return;
  const hotel=session.bundle?.data?.trip?.points?.hotel;
  const hasCoords=Number.isFinite(hotel?.lat)&&Number.isFinite(hotel?.lng);
  $('emergencyHotel').textContent=(hotel?.name||'Название отеля отсутствует в маршруте')+(hasCoords?` · ${hotel.lat.toFixed(5)}, ${hotel.lng.toFixed(5)}`:' · Координаты не указаны');
  $('emergencyMap').hidden=!hasCoords;
  if(hasCoords)$('emergencyMap').href=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(hotel.lat+','+hotel.lng)}`;
  $('emergencyCard').disabled=!session.bundle?.assets?.emergencyPdf;
  $('emergencyDialog').showModal();
});
$('emergencyClose').addEventListener('click',()=>$('emergencyDialog').close());
$('emergencyCard').addEventListener('click',()=>{
  if(!session)return;
  try{
    const bytes=unbase64(session.bundle.assets.emergencyPdf);
    if(bytes.length<5||String.fromCharCode(...bytes.slice(0,5))!=='%PDF-')throw Error('Это не PDF');
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
    const anchor=document.createElement('a');anchor.href=url;anchor.download='dubai-days-emergency-card.pdf';document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }catch{alert('Не удалось подготовить PDF. Откройте раздел помощи внутри путеводителя.')}
});
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
  $('vaultChecks').hidden=true;
  $('mapSettingsDialog').showModal();
  void refreshVaultHealth();
});
$('backupPromptLater').addEventListener('click',acknowledgeBackupPrompt);
$('backupPromptOpen').addEventListener('click',()=>{acknowledgeBackupPrompt();$('mapSettings').click()});
$('cancelMapSettings').addEventListener('click',()=>$('mapSettingsDialog').close());
$('closeVaultSettings').addEventListener('click',()=>$('mapSettingsDialog').close());
$('exportVault').addEventListener('click',exportProtectedBackup);
$('verifyBackup').addEventListener('click',verifyProtectedBackup);
$('checkVault').addEventListener('click',()=>{void checkVaultReadiness()});
$('persistVault').addEventListener('click',async()=>{
  const button=$('persistVault');if(!navigator.storage?.persist)return;
  button.disabled=true;button.textContent='Запрашиваем надёжное хранение…';
  try{const granted=await navigator.storage.persist();await refreshVaultHealth();if(!granted)$('vaultStorageStatus').textContent='Браузер пока не разрешил закрепление. Скачайте защищённую копию и периодически открывайте сайт.'}
  catch{$('vaultStorageStatus').textContent='Не удалось запросить закрепление. Скачайте защищённую копию.';button.disabled=false}
});
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
function openProtectedTicket(id){
  const item=session?.tickets&&Object.hasOwn(session.tickets,id)?session.tickets[id]:null;
  if(!item||typeof item.body!=='string')return false;
  const bytes=unbase64(item.body),type=String(item.type||'').toLowerCase();
  const pdf=type==='application/pdf'&&bytes.length>=5&&String.fromCharCode(...bytes.slice(0,5))==='%PDF-';
  const png=type==='image/png'&&bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
  const jpeg=type==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const webp=type==='image/webp'&&bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
  const preview=pdf||png||jpeg||webp;
  // Unknown types are downloaded, never executed as HTML on the vault origin.
  const url=URL.createObjectURL(new Blob([bytes],{type:preview?type:'application/octet-stream'}));
  const link=document.createElement('a');link.href=url;
  if(preview){link.target='_blank';link.rel='noopener noreferrer'}
  else link.download=String(item.name||'Билет').replace(/[\\/\x00-\x1f]/g,'_').slice(0,120);
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),60000);
  return true;
}
travelExtrasView=initTravelExtras({getSession:()=>session,save:()=>schedulePersist(),downloadBackup:exportProtectedBackup,openTicket:openProtectedTicket});
try{
  if(!crypto?.subtle||!window.indexedDB)throw Error('Для защиты нужен современный браузер и HTTPS.');
  encryptedRecord=await database('get');
  formMode(encryptedRecord?'unlock':'import');
  initPwaUpdates(flush,{serviceWorker:navigator.serviceWorker,get:$,reload:()=>location.reload()});
}catch(error){status(error.message||'Не удалось открыть защищённое хранилище.')}
