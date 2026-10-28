// Build realistic-volume but entirely synthetic test data. Sign the output
// separately using a private key which must never be committed to GitHub.
import {readFile,writeFile} from 'node:fs/promises';
const [baseFile,outputFile]=process.argv.slice(2);
if(!baseFile||!outputFile)throw Error('Expected input fixture and output path');
const fixture=JSON.parse(await readFile(baseFile,'utf8'));
const lengths=[11,12,4,9,18,2,4,1]; // 61 fabricated transport stages
fixture.data.trip.days.forEach((day,index)=>{
  day.title=`Синтетический день ${index+1}`;
  day.stageTimes=Array.from({length:lengths[index]},(_,step)=>`${String(9+Math.floor(step/4)).padStart(2,'0')}:${String(step%4*15).padStart(2,'0')}`);
  day.legs=Array.from({length:lengths[index]},(_,step)=>({
    from:`point-${step}`,to:`point-${step+1}`,mode:'walk',
    title:`Тестовый этап ${index+1}.${step+1}`,how:'Учебный маршрут без реальных адресов и персональной информации.',
  }));
});
fixture.data.trip.points={hotel:{name:'Тестовый отель',lat:25.2,lng:55.3}};
fixture.styles['styles.css']='/* synthetic CSS payload '+('a'.repeat(150000))+' */';
fixture.scripts['app.js']='const __syntheticLoad='+JSON.stringify('x'.repeat(250000))+';';
fixture.assets.hero='R'.repeat(280000);
await writeFile(outputFile,JSON.stringify(fixture));
const size=(await readFile(outputFile)).length;
console.log(`Generated ${size} bytes, ${lengths.reduce((a,b)=>a+b,0)} fabricated stages.`);
