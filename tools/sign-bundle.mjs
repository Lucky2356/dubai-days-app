// Usage: node tools/sign-bundle.mjs <input.json> <private-key.pem> <output.json>
// Keep private keys and personal bundles OUTSIDE the public/ directory.
import {readFileSync,writeFileSync} from 'node:fs';
import {createPrivateKey,sign} from 'node:crypto';

const [, ,input,keyFile,output]=process.argv;
if(!input||!keyFile||!output)throw Error('Expected input bundle, signing key and output path');
const bundle=JSON.parse(readFileSync(input,'utf8'));
if(bundle.format!=='dubai-days-private-import-v1'||!Number.isInteger(bundle.version)||bundle.version<53)
  throw Error('Only official v53+ bundles can be signed');
if(bundle.signature!==undefined)throw Error('Refusing to replace an existing signature');
const key=createPrivateKey(readFileSync(keyFile));
const bytes=Buffer.from('Dubai Days official private bundle v1\n'+JSON.stringify(bundle));
const signature=sign('sha256',bytes,{key,dsaEncoding:'ieee-p1363'}).toString('base64');
bundle.signature={algorithm:'ECDSA-P256-SHA256',value:signature};
writeFileSync(output,JSON.stringify(bundle));
console.log(`Signed private bundle v${bundle.version}`);
