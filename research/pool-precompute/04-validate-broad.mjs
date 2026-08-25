// Broad validation: does CREATE(0x1a478019, n) cover ALL binary pools?
import { getContractAddress } from 'viem';
import { gql } from './rpc.mjs';
const DEPLOYER = '0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
const MAX_NONCE = 1000;
const create2nonce = new Map();
for (let n = 0; n <= MAX_NONCE; n++)
  create2nonce.set(getContractAddress({ from: DEPLOYER, nonce: BigInt(n) }).toLowerCase(), n);

// pull distinct pool addresses
const d = await gql(`{ Market(distinct_on: poolAddress, limit: 10000) { poolAddress } }`);
const pools = [...new Set(d.Market.map(m => m.poolAddress.toLowerCase()))];
console.log('distinct poolAddress values from indexer:', pools.length);

const matched = [], unmatched = [];
for (const p of pools) {
  const n = create2nonce.get(p);
  if (n !== undefined) matched.push([p, n]); else unmatched.push(p);
}
console.log(`MATCH CREATE(deployer,n): ${matched.length}/${pools.length}`);
console.log(`UNMATCHED: ${unmatched.length}`);
matched.sort((a,b)=>a[1]-b[1]);
const nonces = matched.map(x=>x[1]);
console.log('nonce range:', Math.min(...nonces), '..', Math.max(...nonces));
const even = nonces.filter(n=>n%2===0).length;
console.log(`even nonces: ${even}, odd: ${nonces.length-even}`);
// stride histogram
const strides = {};
for (let i=1;i<nonces.length;i++){const s=nonces[i]-nonces[i-1];strides[s]=(strides[s]||0)+1;}
console.log('stride histogram:', JSON.stringify(strides));
console.log('first 15 (pool,nonce):'); matched.slice(0,15).forEach(x=>console.log('  ',x[1],x[0]));
console.log('last 10 (pool,nonce):'); matched.slice(-10).forEach(x=>console.log('  ',x[1],x[0]));
if (unmatched.length) { console.log('unmatched sample:'); unmatched.slice(0,10).forEach(p=>console.log('  ',p)); }
import('node:fs').then(fs=>fs.writeFileSync('pools-matched.json',JSON.stringify({matched,unmatched},null,1)));
