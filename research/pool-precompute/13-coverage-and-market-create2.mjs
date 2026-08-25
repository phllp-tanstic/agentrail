import { rpc, gql } from './rpc.mjs';
import { getContractAddress, getCreate2Address, keccak256, concat, pad, toHex, encodeAbiParameters, parseAbiParameters } from 'viem';
import fs from 'node:fs';
const DEPLOYER='0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
const bank = new Set(JSON.parse(fs.readFileSync('pools-matched.json','utf8')).matched.map(x=>x[0]));
const MIGRATION_BLOCK = 391482264;

// ---- (1) COVERAGE: since migration, does every BINARY market use a pool from the 134-bank? ----
let off=0, total=0, outside=[], pools=new Set();
while(true){
  const d = await gql(`{ Market(where:{marketType:{_eq:"BINARY"}, createdAtBlock:{_gte:"${MIGRATION_BLOCK}"}}, order_by:{createdAtBlock: asc}, limit:1000, offset:${off}){ poolAddress createdAtBlock marketId nonce } }`);
  if(!d.Market.length) break;
  for(const m of d.Market){ total++; const p=m.poolAddress.toLowerCase(); pools.add(p);
    if(!bank.has(p)) outside.push(m); }
  off+=d.Market.length; if(d.Market.length<1000) break;
}
console.log(`BINARY markets since migration block ${MIGRATION_BLOCK}: ${total}`);
console.log(`  distinct pools used: ${pools.size}`);
console.log(`  markets using a pool OUTSIDE the 134-pool bank: ${outside.length}`);
if(outside.length) console.log('  e.g.', JSON.stringify(outside.slice(0,4)));
console.log(`  => bank coverage: ${((total-outside.length)/total*100).toFixed(3)}%`);
console.log(`  reuse factor: ${(total/pools.size).toFixed(1)}x markets per pool`);

// ---- (2) is the per-market contract a CREATE2 clone from the same deployer? ----
const MKT_IMPL='0x6b2fee58f90aee79be03e417213c547526791102';
const initcode = concat(['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', MKT_IMPL, '0x5af43d82803e903d91602b57fd5bf3']);
const ih = keccak256(initcode);
console.log('\nEIP-1167 clone initcode hash (impl '+MKT_IMPL+'):', ih);
const s = await gql(`{ Market(where:{marketType:{_eq:"BINARY"}, createdAtBlock:{_gte:"${MIGRATION_BLOCK}"}}, order_by:{createdAtBlock: desc}, limit:6){ marketId marketAddress poolAddress nonce asset intervalSec expiry tradingStart } }`);
const cands = (m)=>{
  const P = pad(m.poolAddress,{size:32}); const N=pad(toHex(BigInt(m.nonce)),{size:32});
  return {
    'marketId': m.marketId,
    'keccak(pool,nonce)': keccak256(concat([P,N])),
    'keccak(abi(pool,uint256 nonce))': keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'),[m.poolAddress, BigInt(m.nonce)])),
    'pad(nonce)': N,
  };
};
let mHit=0;
for(const m of s.Market){
  let found=null;
  for(const [lbl,salt] of Object.entries(cands(m))){
    const a = getCreate2Address({from:DEPLOYER, salt, bytecodeHash: ih});
    if(a.toLowerCase()===m.marketAddress.toLowerCase()){ found=lbl; break; }
  }
  console.log(`  mkt ${m.marketId} addr ${m.marketAddress} -> CREATE2 salt match: ${found||'NONE of the tried salts'}`);
  if(found) mHit++;
}
console.log(`market CREATE2 salt guesses matched: ${mHit}/${s.Market.length}`);
// is marketAddress even at a CREATE nonce of deployer?
const cmap=new Map(); for(let n=0;n<=1200;n++) cmap.set(getContractAddress({from:DEPLOYER,nonce:BigInt(n)}).toLowerCase(),n);
console.log('marketAddresses at a CREATE nonce of deployer?', s.Market.map(m=>cmap.get(m.marketAddress.toLowerCase())??'no').join(','));
