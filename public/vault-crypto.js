// Stable encrypted vault format. Changing its fields or parameters requires
// a compatible migration and regression tests for existing backups.
const ITERATIONS=310000;
const encoder=new TextEncoder(),decoder=new TextDecoder();

export const base64=bytes=>{let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(text)};
export const unbase64=value=>Uint8Array.from(atob(value),ch=>ch.charCodeAt(0));

export async function keyFromPassword(password,salt){
  const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:ITERATIONS,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptValue(value,key,salt){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode(JSON.stringify(value)));
  return {format:'dubai-days-locked-v1',iterations:ITERATIONS,salt:base64(salt),iv:base64(iv),ciphertext:base64(new Uint8Array(ciphertext))};
}
export async function decryptValue(record,key){
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:unbase64(record.iv)},key,unbase64(record.ciphertext));
  return JSON.parse(decoder.decode(plaintext));
}
