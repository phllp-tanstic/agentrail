import { gql, rpc } from './rpc.mjs';
import fs from 'node:fs';
const { matched } = JSON.parse(fs.readFileSync('pools-matched.json','utf8'));
const beaconSet = new Set(matched.map(x=>x[0]));

// Pull recent binary markets ordered by createdAtBlock desc
const N = 4000;
const d = await gql(`{ Market(where:{marketType:{_eq:"BINARY"}}, order_by:{createdAtBlock: desc}, limit:${N}){ marketId poolAddress nonce createdAtBlock asset intervalSec } }`);
const ms = d.Market;
console.log('pulled', ms.length, 'recent BINARY markets; block range', ms[ms.length-1].createdAtBlock, '..', ms[0].createdAtBlock);

// walk from newest, find the first market whose pool is NOT in the beacon set
let firstOld = -1;
for (let i=0;i<ms.length;i++){ if(!beaconSet.has(ms[i].poolAddress.toLowerCase())){ firstOld = i; break; } }
console.log('newest->oldest: first non-beacon pool at index', firstOld, firstOld>=0? JSON.stringify(ms[firstOld]) : '(none in window)');

// windows
for (const W of [200, 500, 1000, 2000, 4000]) {
  const w = ms.slice(0, Math.min(W, ms.length));
  const pools = new Set(w.map(m=>m.poolAddress.toLowerCase()));
  const inBeacon = [...pools].filter(p=>beaconSet.has(p)).length;
  console.log(`last ${w.length} markets -> ${pools.size} distinct pools (beacon-set: ${inBeacon}, other: ${pools.size-inBeacon}) reuse=${(w.length/pools.size).toFixed(2)}x`);
}
// max market-nonce per pool in newest 2000
const maxNonce = {};
for (const m of ms.slice(0,2000)) { const p=m.poolAddress.toLowerCase(); const n=Number(m.nonce); if(!(p in maxNonce)||n>maxNonce[p]) maxNonce[p]=n; }
const vals = Object.values(maxNonce).sort((a,b)=>b-a);
console.log('per-pool max market nonce (top 12):', vals.slice(0,12).join(','), ' | pools:', vals.length);
