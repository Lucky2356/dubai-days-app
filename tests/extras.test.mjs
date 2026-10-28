import test from 'node:test';
import assert from 'node:assert/strict';
import {routeSkipIssues,suggestedSkips,quickStagesForDay} from '../public/vault-extras.js';

const tripDay={
  title:'Прилёт и супермаркет',
  legs:[
    {from:'hotel',to:'festival',mode:'abra',title:'Лодка → Festival City'},
    {from:'festival',to:'carrefour',mode:'walk',title:'Festival City → супермаркет',how:'Купить продукты'},
    {from:'carrefour',to:'festival',mode:'walk',title:'Супермаркет → причал'},
    {from:'festival',to:'hotel',mode:'abra',title:'Возвращение домой'}
  ],
  stageTimes:['16:50','17:15','19:00','19:20']
};

test('Plan B never suggests a disconnected single leg',()=>{
  assert.ok(routeSkipIssues(tripDay,[1]).length>0);
  assert.deepEqual(suggestedSkips(tripDay,60),[1,2]);
  assert.deepEqual(routeSkipIssues(tripDay,suggestedSkips(tripDay,60)),[]);
  assert.deepEqual(suggestedSkips(tripDay,30),[]);
});

test('Plan B rejects missing start, missing end and unknown stages',()=>{
  assert.match(routeSkipIssues(tripDay,[0])[0],/исходной точке/);
  assert.match(routeSkipIssues(tripDay,[3])[0],/не заканчивается/);
  assert.match(routeSkipIssues(tripDay,[999])[0],/неизвестный этап/);
  assert.match(routeSkipIssues(tripDay,[0,1,2,3])[0],/все переходы/);
});

test('Plan B does not remove ticketed attraction transport just because it is a return trip',()=>{
  const day={legs:[
    {from:'gateway',to:'atlantis',mode:'mono',title:'Монорельс → Atlantis',how:'Купить билет'},
    {from:'atlantis',to:'gateway',mode:'mono',title:'Монорельс обратно'}
  ]};
  assert.deepEqual(suggestedSkips(day,120),[]);
});

test('desert safari schedule appears after its two lunch legs in quick navigation',()=>{
  const day={title:'Пустыня с ужином',summary:'Обед и вечернее сафари',
    legs:[{title:'Обед',how:'Пешком'},{title:'Обратно',how:'Пешком'}],stageTimes:['11:50','13:10'],
    schedule:[
      {title:'Спокойное утро',time:'09:00'},
      {title:'Трансфер организатора',time:'≈ 14:30–15:30',detail:'Водитель заберёт у отеля'},
      {title:'Пустыня, программа и ужин',time:'≈ 16:00–20:30'},
      {title:'Возвращение в отель',time:'≈ 21:00–22:00'}
    ]};
  const stages=quickStagesForDay(day);
  assert.equal(stages.length,5);
  assert.match(stages[3].title,/Пустыня/);
  assert.match(stages[2].time,/14:30/);
  assert.equal(quickStagesForDay({...day,title:'Пляж',summary:''}).length,2);
});
