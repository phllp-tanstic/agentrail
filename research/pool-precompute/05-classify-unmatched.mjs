import { rpc, gql } from './rpc.mjs';
import fs from 'node:fs';
const { matched, unmatched } = JSON.parse(fs.readFileSync('pools-matched.json','utf8'));
const BEACON_RUNTIME_PREFIX = '0x60806040819052635c60da1b60e01b';
async function classify(list, label) {
  const kinds = {};
  const samples = {};
  for (const a of list) {
    let code;
    try { code = await rpc('eth_getCode',[a,'latest']); } catch(e){ code='ERR'; }
    const len = (code.length-2)/2;
    let k;
    if (len === 0) k = 'NO_CODE(empty!)';
    else if (code.startsWith(BEACON_RUNTIME_PREFIX)) k = `beaconProxy(len${len})`;
    else if (code.startsWith('0x363d3d373d3d3d363d73')) k = `eip1167clone(len${len})`;
    else k = `other(len${len})`;
    kinds[k]=(kinds[k]||0)+1;
    if(!samples[k]) samples[k]=a;
  }
  console.log(`\n${label} (${list.length} sampled):`);
  for (const [k,v] of Object.entries(kinds)) console.log(`   ${k}: ${v}   e.g. ${samples[k]}`);
}
// sample 25 random unmatched + all-ish matched sample
const shuf = [...unmatched].sort(()=>Math.random()-0.5).slice(0,25);
await classify(shuf, 'UNMATCHED pools (random 25)');
await classify(matched.slice(0,8).map(x=>x[0]), 'MATCHED pools (first 8)');
