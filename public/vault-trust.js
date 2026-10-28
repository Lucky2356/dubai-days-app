// Only the public verification key and fingerprints of previously distributed
// official bundles live on GitHub Pages. Never publish the signing private key.
const TRUSTED_KEY={
  kty:'EC',crv:'P-256',
  x:'SC1diMMCasr9ig0ZDEuD77F8dff0gJNTY3RKF9JyY_4',
  y:'Q9NO3ruegYMsMMVJzPDDtv2c_rMeDOGxmnlBTtRNMKI',
};
const LEGACY_SHA256=new Set([
  'c857f211ac783cf405b47a72a44d68ac859655463b4a09489e896536ae0e9478', // v49
  '91453f29ce8cf6ac062fa4bc9abafe4a44ee663b9a8cc45fb892a240dad07874', // v50
  'af0fb1a2738993c6d6f060086c493f9dd7003a972e21b6a77d34c7e08e760175', // v51
  '85fd5eb2506878d4ba519547d051910236df5f17b21e76f95dd7351f7673e672', // v52
]);
const encoder=new TextEncoder();
const signaturePayload=bundle=>{
  const {signature,...unsigned}=bundle;
  return encoder.encode('Dubai Days official private bundle v1\n'+JSON.stringify(unsigned));
};
function decodeBase64(value){
  const bytes=atob(value);
  return Uint8Array.from(bytes,character=>character.charCodeAt(0));
}
async function digestHex(bytes){
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return [...digest].map(value=>value.toString(16).padStart(2,'0')).join('');
}
export async function verifyBundleTrust(bundle){
  if(!bundle||typeof bundle!=='object'||Array.isArray(bundle))throw Error('Неверный формат пакета.');
  if(bundle.signature!==undefined){
    const signature=bundle.signature;
    if(signature?.algorithm!=='ECDSA-P256-SHA256'||typeof signature.value!=='string'||signature.value.length>200)
      throw Error('Неподдерживаемая подпись маршрута.');
    try{
      const key=await crypto.subtle.importKey('jwk',TRUSTED_KEY,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
      const ok=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decodeBase64(signature.value),signaturePayload(bundle));
      if(ok)return 'signed';
    }catch{}
    throw Error('Цифровая подпись маршрута неверна. Не открывайте изменённый файл.');
  }
  const digest=await digestHex(encoder.encode(JSON.stringify(bundle)));
  if(LEGACY_SHA256.has(digest))return 'legacy-official';
  throw Error('Файл не подтверждён как официальный Dubai Days. Используйте подписанный пакет v53 или проверенную старую копию.');
}
