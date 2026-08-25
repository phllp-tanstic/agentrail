import { toFunctionSelector } from 'viem';
const base='file:///C:/Users/Aseja Oluwatobi/agentrail/research/onchain-proof/node_modules/@somnia-chain/markets-sdk/dist/';
const M = await import(base+'contractErrorsAbi.js');
const key = Object.keys(M).find(k=>Array.isArray(M[k]));
const abi = M[key];
console.log('export:', key, 'entries:', abi.length);
const errs = abi.filter(e=>e.type==='error');
console.log('errors:', errs.length);
const map = {};
for (const e of errs) {
  const sig = `${e.name}(${e.inputs.map(i=>i.type).join(',')})`;
  map[toFunctionSelector(sig)] = sig;
}
import fs from 'node:fs';
fs.writeFileSync('error-selectors.json', JSON.stringify(map,null,2));
console.log('wrote error-selectors.json with', Object.keys(map).length, 'selectors');
console.log('\n0x3fb0ba2e =>', map['0x3fb0ba2e'] ?? 'NOT FOUND');
console.log('\n--- tick / price / quantity / lot related ---');
for (const [s,sig] of Object.entries(map)) if (/tick|price|lot|quantity|round|granul|multipl/i.test(sig)) console.log(s, sig);
console.log('\n--- operator / approv / auth related ---');
for (const [s,sig] of Object.entries(map)) if (/operator|approv|auth|onlyapp/i.test(sig)) console.log(s, sig);
