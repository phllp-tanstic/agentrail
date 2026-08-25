import { rpc, gql } from './rpc.mjs';
import { getContractAddress, keccak256, encodeAbiParameters, concat, pad, toHex } from 'viem';
import fs from 'node:fs';
const DEPLOYER='0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
const matched = JSON.parse(fs.readFileSync('pools-matched.json','utf8')).matched;
const nonceOf = new Map(matched.map(([a,n])=>[a,n]));

// 1) which pools serve the newest markets, and at what deployer-nonce?
const d = await gql(`{ Market(where:{marketType:{_eq:"BINARY"}}, order_by:{createdAtBlock: desc}, limit: 600){ poolAddress nonce asset intervalSec createdAtBlock marketAddress marketId } }`);
const hot = new Map();
for (const m of d.Market){ const p=m.poolAddress.toLowerCase();
  if(!hot.has(p)) hot.set(p,{count:0,assets:new Set(),ivs:new Set(),maxN:0});
  const h=hot.get(p); h.count++; h.assets.add(m.asset); h.ivs.add(m.intervalSec); h.maxN=Math.max(h.maxN,Number(m.nonce)); }
console.log(`HOT POOLS serving newest ${d.Market.length} markets: ${hot.size}`);
for (const [p,h] of [...hot].sort((a,b)=>(nonceOf.get(a[0])??1e9)-(nonceOf.get(b[0])??1e9)))
  console.log(`  deployerNonce=${String(nonceOf.get(p)).padStart(4)} ${p} mkts=${h.count} maxMarketNonce=${h.maxN} assets=[${[...h.assets]}] intervals=[${[...h.ivs]}]`);

// 2) nonce burn rate: deployer nonce at historical blocks
console.log('\nDEPLOYER NONCE OVER TIME');
const head = parseInt(await rpc('eth_blockNumber',[]),16);
const pts=[];
for (const back of [0, 500000, 1000000, 2000000, 4000000, 8000000, 14000000]) {
  const bn = head-back; if (bn<0) continue;
  const n = parseInt(await rpc('eth_getTransactionCount',[DEPLOYER, '0x'+bn.toString(16)]),16);
  const b = await rpc('eth_getBlockByNumber',['0x'+bn.toString(16),false]);
  pts.push({bn, ts:parseInt(b.timestamp,16), n});
}
pts.sort((a,b)=>a.bn-b.bn);
for (let i=0;i<pts.length;i++){
  const p=pts[i]; const dt=new Date(p.ts*1000).toISOString().slice(0,16);
  let rate='';
  if(i>0){const dn=p.n-pts[i-1].n; const dd=(p.ts-pts[i-1].ts)/86400; rate=` | +${dn} nonces over ${dd.toFixed(2)}d = ${(dn/Math.max(dd,1e-9)).toFixed1||(dn/Math.max(dd,1e-9)).toFixed(1)}/day`;}
  console.log(`  block ${p.bn} ${dt} nonce=${p.n}${rate}`);
}

// 3) find the block where pool #274 got code (binary search) => last pool deploy time
async function firstCodeBlock(addr, lo, hi){
  while(lo<hi){ const mid=Math.floor((lo+hi)/2);
    const c = await rpc('eth_getCode',[addr,'0x'+mid.toString(16)]);
    if (c && c!=='0x') hi=mid; else lo=mid+1; }
  return lo;
}
const p274 = getContractAddress({from:DEPLOYER,nonce:274n});
const p264 = getContractAddress({from:DEPLOYER,nonce:264n});
for (const [lbl,a] of [['pool nonce=264',p264],['pool nonce=274',p274]]) {
  const b = await firstCodeBlock(a, head-20000000>0?head-20000000:1, head);
  const blk = await rpc('eth_getBlockByNumber',['0x'+b.toString(16),false]);
  console.log(`${lbl} ${a} first has code at block ${b} (${new Date(parseInt(blk.timestamp,16)*1000).toISOString()})`);
}
console.log('current head', head, 'deployer nonce now', parseInt(await rpc('eth_getTransactionCount',[DEPLOYER,'latest']),16));
