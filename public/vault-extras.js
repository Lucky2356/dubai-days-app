// Optional trip tools. All user notes and decisions stay inside the existing
// AES-GCM encrypted session; this module does not fetch or transmit trip data.
const $=id=>document.getElementById(id);
const option=(label,value)=>new Option(String(label),String(value));
const safeDay=(session,value)=>Math.max(0,Math.min((session?.bundle?.data?.trip?.days?.length||1)-1,Number(value)||0));
const coords=point=>Number.isFinite(point?.lat)&&Number.isFinite(point?.lng);
const mapURL=point=>`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(point.lat+','+point.lng)}`;
const normalize=value=>String(value||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
const blankState=()=>({checks:{},diary:{},plans:{}});
const hotelArabic='أربيان بارك دبي'; // Official Arabic Rotana page, verified 28 October 2026.

function state(session){
  if(!session.travelExtras||typeof session.travelExtras!=='object'||Array.isArray(session.travelExtras))session.travelExtras=blankState();
  for(const key of ['checks','diary','plans'])if(!session.travelExtras[key]||typeof session.travelExtras[key]!=='object'||Array.isArray(session.travelExtras[key]))session.travelExtras[key]={};
  return session.travelExtras;
}
function checklist(day){
  const description=normalize([day.title,day.summary,...(day.tags||[])].join(' '));
  const items=[['basics','Телефон, заряд и необходимые документы'],['water','Вода и средства защиты от солнца']];
  if(/билет|музей|лувр|мечет|дворец|бурдж|экскурс|пустын/i.test(description))items.push(['ticket','Проверить бронирования и условия входа']);
  if(/пляж|купани|аква|бассейн|море/i.test(description))items.push(['beach','Купальные принадлежности и полотенце']);
  if(/мечет|абу-даби/i.test(description))items.push(['clothes','Уточнить требования к одежде для посещения мечети']);
  if(/вылет|аэропорт|прилёт/i.test(description))items.push(['airport','Проверить паспорт, рейс, багаж и время трансфера']);
  if(/пустын|сафари/i.test(description))items.push(['desert','Закрытая обувь, вода и подтверждение времени трансфера']);
  return items;
}
function shifted(value,minutes){
  const match=String(value||'').match(/^(?:≈\s*)?(\d{1,2}):(\d{2})/);
  if(!match)return value||'По плану';
  const total=Number(match[1])*60+Number(match[2])+minutes;
  return `${String(Math.floor(total/60)%24).padStart(2,'0')}:${String(total%60).padStart(2,'0')}*`;
}
// A leg is a journey between two distinct places, not an independent visit.
// Skipping one leg usually strands the traveller at the wrong departure point.
export function routeSkipIssues(day,skipped){
  const legs=day?.legs||[],indices=new Set(skipped),issues=[];
  if([...indices].some(i=>!Number.isInteger(i)||i<0||i>=legs.length))issues.push('В варианте есть неизвестный этап.');
  if(!legs.length)return issues;
  const kept=legs.filter((_,i)=>!indices.has(i));
  if(!kept.length)return [...issues,'Нельзя убрать все переходы: проверьте, как добраться до конца дня.'];
  if(kept[0].from!==legs[0].from)issues.push('Первый оставшийся этап начинается не в исходной точке дня.');
  for(let i=1;i<kept.length;i++)if(kept[i-1].to!==kept[i].from)
    issues.push(`Нет перехода между «${kept[i-1].title||kept[i-1].to}» и «${kept[i].title||kept[i].to}».`);
  if(kept.at(-1).to!==legs.at(-1).to)issues.push('Вариант не заканчивается в запланированной точке.');
  return issues;
}
export function suggestedSkips(day,delay){
  if(delay<60||!Array.isArray(day?.legs))return [];
  const optional=/супермаркет|магазин|кафе|обед|ресторан|кофе|сувенир/i;
  const candidates=[];
  // Only offer two walking legs that form a verified return to the same place.
  // Never automatically remove a transfer, a ticketed attraction or a return trip.
  for(let i=0;i<day.legs.length-1;i++){
    const a=day.legs[i],b=day.legs[i+1];
    if(a.mode!=='walk'||b.mode!=='walk'||a.from!==b.to||!optional.test(normalize(a.title+' '+a.how)))continue;
    const group=[i,i+1];
    if(!routeSkipIssues(day,group).length)candidates.push(group);
  }
  const chosen=[],limit=delay>=120?3:delay>=90?2:1;
  for(const group of candidates){if(chosen.length>=limit*2)break;if(group.some(i=>chosen.includes(i)))continue;chosen.push(...group)}
  return chosen;
}

// Keep significant scheduled experiences visible when a day has only a few
// transport legs (e.g. the organised desert safari on day six).
export function quickStagesForDay(day){
  if(!day)return [];
  const stages=(day.legs||[]).map((leg,index)=>({title:leg.title||leg.to||'Этап',how:leg.how||'',time:day.stageTimes?.[index]||''}));
  if(stages.length<=2&&/пустын|сафари/i.test(day.title+' '+day.summary)){
    const events=(day.schedule||[]).filter(event=>/трансфер организатора|пустын|сафари|возвращение в отель/i.test(event.title||''));
    for(const event of events)stages.push({title:'Программа: '+event.title,how:event.detail||'Уточните детали у организатора.',time:event.time||''});
  }
  return stages;
}

export function initTravelExtras({getSession,save,downloadBackup,openTicket}){
  let shownDay=0;
  let selectedTicket=null;
  const trip=()=>getSession()?.bundle?.data?.trip;
  const day=()=>trip()?.days?.[shownDay];
  const current=()=>getSession()&&state(getSession());
  const commit=()=>{save();};

  function showChecklist(){
    const source=day();if(!source)return;
    const checked=new Set(current().checks[shownDay]||[]),holder=$('extrasChecklistItems');holder.replaceChildren();
    for(const [id,label] of checklist(source)){
      const wrapper=document.createElement('label');wrapper.className='extras-checkline';
      const input=document.createElement('input');input.type='checkbox';input.checked=checked.has(id);
      input.addEventListener('change',()=>{
        const next=new Set(current().checks[shownDay]||[]);input.checked?next.add(id):next.delete(id);
        current().checks[shownDay]=[...next];commit();
        $('extrasChecklistStatus').textContent=`Отмечено ${next.size} пунктов · сохраняется в защищённом хранилище`;
      });
      const text=document.createElement('span');text.textContent=label;wrapper.append(input,text);holder.append(wrapper);
    }
    $('extrasChecklistStatus').textContent=`Отмечено ${checked.size} из ${checklist(source).length}`;
  }

  function planSelections(){return [...$('extrasSkip').querySelectorAll('input[type="checkbox"]')].filter(input=>input.checked).map(input=>Number(input.value))}
  function planPreview(){
    const source=day(),skip=new Set(planSelections()),delay=Number($('extrasDelay').value)||0;
    const list=$('extrasPlanPreview');list.replaceChildren();if(!source)return;
    source.legs.forEach((leg,index)=>{
      const li=document.createElement('li');const dropped=skip.has(index);
      li.textContent=`${dropped?'Пропустить':'≈ '+shifted(source.stageTimes?.[index],delay)} · ${leg.title||leg.to||'Этап'}`;
      if(dropped)li.classList.add('extras-skipped');list.append(li);
    });
    const issues=routeSkipIssues(source,skip);
    $('extrasSavePlan').disabled=issues.length>0;
    $('extrasPlanWarning').textContent=(issues.length?'⚠ Нельзя сохранить разорванный маршрут: '+issues.join(' ')+' Выберите связанные переходы целиком. ':'')+'* Время приблизительное: смещение на '+delay+' мин. Длительность этапов, транспорт и время входа не пересчитаны. Бронирования перепроверьте вручную.';
  }
  function showPlan(){
    const source=day();if(!source)return;
    const previous=current().plans[shownDay]||{};
    $('extrasDelay').value=String([30,60,90,120].includes(previous.delay)?previous.delay:60);
    const skip=new Set(Array.isArray(previous.skip)?previous.skip:[]),holder=$('extrasSkip');holder.replaceChildren();
    source.legs.forEach((leg,index)=>{
      const wrapper=document.createElement('label');wrapper.className='extras-checkline';
      const input=document.createElement('input');input.type='checkbox';input.value=String(index);input.checked=skip.has(index);
      input.addEventListener('change',()=>{$('extrasPlanStatus').textContent='Изменения ещё не сохранены.';planPreview()});
      const label=document.createElement('span');label.textContent=`Не посещать: ${leg.title||leg.to||'Этап'}`;
      wrapper.append(input,label);holder.append(wrapper);
    });
    $('extrasPlanStatus').textContent=previous.savedAt?'Сохранён предыдущий вариант: '+new Date(previous.savedAt).toLocaleString('ru-RU'):'';
    planPreview();
  }
  function showDiary(){
    $('extrasDiaryText').value=String(current().diary[shownDay]||'').slice(0,2500);
    $('extrasDiaryStatus').textContent='Заметка сохраняется автоматически при вводе.';
  }
  function showTaxi(){
    const point=trip()?.points?.hotel;
    const arabian=/arabian park/i.test(point?.name||'');
    $('extrasTaxiEnglish').textContent=point?.name||'Отель из маршрута';
    $('extrasTaxiAddress').textContent=arabian?'Al Jaddaf Street, Dubai, United Arab Emirates':'Уточните адрес своего отеля перед поездкой.';
    $('extrasTaxiArabic').textContent=arabian?`${hotelArabic}، الجداف، دبي`:'Арабское написание не подтверждено';
    $('extrasTaxiCoordinates').textContent=coords(point)?`GPS: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`:'Координат нет в маршруте';
    $('extrasTaxiStatus').textContent='';
  }

  function records(){
    const session=getSession(),route=trip(),found=[];
    if(!session||!route)return found;
    route.days.forEach((item,dayIndex)=>{
      found.push({name:`День ${dayIndex+1}: ${item.title||item.date}`,subtitle:item.summary||'',day:dayIndex});
      item.legs.forEach((leg,step)=>found.push({name:leg.title||leg.to||'Этап',subtitle:leg.how||'',time:item.stageTimes?.[step]||'',day:dayIndex,point:route.points?.[leg.to]}));
      (item.schedule||[]).forEach(event=>found.push({name:event.title,subtitle:event.detail||'',time:event.time||'',day:dayIndex}));
    });
    Object.values(route.points||{}).forEach(point=>found.push({name:point.name||'Место',subtitle:'Место на карте',point}));
    Object.entries(session.tickets||{}).forEach(([ticketId,ticket])=>found.push({name:ticket.name||'Билет',subtitle:'Вложенный билет · откройте или скачайте файл',ticketId}));
    Object.entries(current().diary).forEach(([key,note])=>{if(note)found.push({name:`Заметка · день ${Number(key)+1}`,subtitle:String(note),day:Number(key)})});
    return found;
  }
  function placeCard(record){
    selectedTicket=record.ticketId||null;
    $('extrasPlaceCard').hidden=false;
    $('extrasPlaceTime').textContent=(Number.isInteger(record.day)?`День ${record.day+1} · `:'')+(record.time||'');
    $('extrasPlaceTitle').textContent=record.name;
    $('extrasPlaceHow').textContent=record.subtitle||'Подробности смотрите в плане дня.';
    $('extrasPlaceMap').hidden=!coords(record.point);
    if(coords(record.point))$('extrasPlaceMap').href=mapURL(record.point);
    $('extrasTicketOpen').hidden=!selectedTicket;
    $('extrasTicketStatus').textContent='';
  }
  function showSearch(){
    const query=normalize($('extrasQuery').value).trim(),holder=$('extrasSearchResults');holder.replaceChildren();
    selectedTicket=null;$('extrasPlaceCard').hidden=true;
    if(query.length<2){holder.textContent='Введите хотя бы 2 символа. Поиск работает локально и без интернета.';return}
    const found=records().filter(item=>normalize(item.name+' '+item.subtitle).includes(query)).slice(0,30);
    for(const record of found){const button=document.createElement('button');button.type='button';button.className='extras-result';
      const title=document.createElement('strong');title.textContent=record.name;
      const detail=document.createElement('small');detail.textContent=(Number.isInteger(record.day)?`День ${record.day+1} · `:'')+(record.time||record.subtitle||'').slice(0,100);
      button.append(title,detail);button.addEventListener('click',()=>placeCard(record));holder.append(button);
    }
    if(!found.length)holder.textContent='Ничего не найдено. Попробуйте другое название.';
  }
  function render(){
    if(!getSession())return;
    const mode=$('extrasMode').value;
    for(const [name,id] of [['checklist','extrasChecklist'],['planb','extrasPlanb'],['search','extrasSearch'],['diary','extrasDiary'],['taxi','extrasTaxi'],['share','extrasShare']])$(id).hidden=name!==mode;
    $('extrasDayRow').hidden=!['checklist','planb','diary'].includes(mode);
    if(mode==='checklist')showChecklist();
    if(mode==='planb')showPlan();
    if(mode==='search')showSearch();
    if(mode==='diary')showDiary();
    if(mode==='taxi')showTaxi();
  }
  function open(mode='checklist'){
    const session=getSession(),days=trip()?.days||[];if(!session||!days.length)return;
    state(session);
    const saved=(()=>{try{return JSON.parse(session.storage?.['dubai-days-personal-v1']||'{}')}catch{return {}}})();
    shownDay=safeDay(session,saved.lastDay);
    $('extrasDay').replaceChildren();days.forEach((item,index)=>$('extrasDay').add(option(`${index+1}. ${item.date} · ${item.title}`,index)));
    $('extrasDay').value=String(shownDay);
    $('extrasMode').value=mode;render();$('travelExtrasDialog').showModal();
  }
  $('travelExtrasOpen').addEventListener('click',()=>open());
  $('travelExtrasClose').addEventListener('click',()=>$('travelExtrasDialog').close());
  $('taxiCardOpen').addEventListener('click',()=>{$('emergencyDialog').close();open('taxi')});
  $('extrasMode').addEventListener('change',render);
  $('extrasDay').addEventListener('change',()=>{shownDay=safeDay(getSession(),$('extrasDay').value);render()});
  $('extrasDelay').addEventListener('change',()=>{$('extrasPlanStatus').textContent='Изменения ещё не сохранены.';planPreview()});
  $('extrasSuggest').addEventListener('click',()=>{
    const chosen=new Set(suggestedSkips(day(),Number($('extrasDelay').value)||0));
    $('extrasSkip').querySelectorAll('input').forEach(input=>{input.checked=chosen.has(Number(input.value))});planPreview();
    $('extrasPlanStatus').textContent=chosen.size?'Предложение подготовлено: проверьте, подходят ли пропуски.':'Нет очевидно необязательных остановок — выбирайте вручную.';
  });
  $('extrasSavePlan').addEventListener('click',()=>{
    const issues=routeSkipIssues(day(),planSelections());
    if(issues.length){planPreview();$('extrasPlanStatus').textContent='⚠ Исправьте разрыв маршрута перед сохранением.';return}
    current().plans[shownDay]={delay:Number($('extrasDelay').value),skip:planSelections(),savedAt:new Date().toISOString()};
    commit();$('extrasPlanStatus').textContent='✓ Вариант сохранён отдельно от основного маршрута.';
  });
  $('extrasQuery').addEventListener('input',showSearch);
  $('extrasTicketOpen').addEventListener('click',()=>{
    if(!selectedTicket)return;
    try{$('extrasTicketStatus').textContent=openTicket?.(selectedTicket)?'✓ Билет открыт или скачан.':'Билет не найден. Проверьте сохранённые вложения.'}
    catch{$('extrasTicketStatus').textContent='Не удалось открыть вложение. Проверьте файл билета.'}
  });
  $('extrasDiaryText').addEventListener('input',()=>{
    // Update the encrypted session immediately so day/mode switches and a lock
    // cannot discard a draft. schedulePersist coalesces input within a task.
    current().diary[shownDay]=$('extrasDiaryText').value.slice(0,2500);
    commit();$('extrasDiaryStatus').textContent='Сохраняется автоматически…';
  });
  $('extrasDiarySave').addEventListener('click',()=>{
    current().diary[shownDay]=$('extrasDiaryText').value.slice(0,2500);commit();
    $('extrasDiaryStatus').textContent='✓ Заметка сохранена в зашифрованном хранилище.';
  });
  $('extrasTaxiCopy').addEventListener('click',async()=>{
    const value=[$('extrasTaxiEnglish').textContent,$('extrasTaxiAddress').textContent,$('extrasTaxiArabic').textContent,$('extrasTaxiCoordinates').textContent].join('\n');
    try{await navigator.clipboard.writeText(value);$('extrasTaxiStatus').textContent='✓ Адрес скопирован.'}
    catch{$('extrasTaxiStatus').textContent='Копирование недоступно — покажите этот экран водителю.'}
  });
  $('extrasShareBackup').addEventListener('click',()=>{
    if(!confirm('Копия включает личный маршрут, расходы, билеты и брони. Передавайте файл только доверенному человеку, а пароль — отдельно. Скачать?'))return;
    $('travelExtrasDialog').close();void downloadBackup();
  });
  return {close:()=>{if($('travelExtrasDialog').open)$('travelExtrasDialog').close()}};
}
