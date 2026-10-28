// PWA updates are offered explicitly. Never reload a running private session
// until its encrypted changes are safely persisted.
export function initPwaUpdates(flush,{serviceWorker,get,reload}){
  if(!serviceWorker)return;
  const notice=get('updateNotice'),label=get('updateText'),button=get('applyUpdate');
  let updateRequested=false;
  function showUpdate(){if(updateRequested)return;notice.hidden=false;label.textContent='Доступна новая версия путеводителя.'}
  function watchUpdate(registration){
    if(registration.waiting&&serviceWorker.controller)showUpdate();
    registration.addEventListener('updatefound',()=>{
      const worker=registration.installing;
      worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&serviceWorker.controller)showUpdate()});
    });
  }
  async function applyUpdate(){
    button.disabled=true;label.textContent='Сохраняем данные перед обновлением…';
    try{
      await flush();
      const registration=await serviceWorker.getRegistration();
      if(!registration?.waiting)throw Error('Обновление пока не готово. Попробуйте ещё раз.');
      updateRequested=true;label.textContent='Обновляем путеводитель…';
      registration.waiting.postMessage({type:'APPLY_UPDATE'});
    }catch(error){
      updateRequested=false;label.textContent='Обновление отменено: '+(error?.message||'ошибка сохранения');button.disabled=false;
    }
  }
  serviceWorker.addEventListener('controllerchange',()=>{if(updateRequested)reload()});
  button.addEventListener('click',applyUpdate);
  return serviceWorker.register('./sw.js').then(watchUpdate).catch(()=>{});
}
