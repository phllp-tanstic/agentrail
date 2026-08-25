// Scan CREATE(deployer, n) for n=0..900: does code exist? is it a beacon pool?
import { getContractAddress } from 'viem';
import { rpc } from './rpc.mjs';
import fs from 'node:fs';
const DEPLOYER = '0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
const BEACON_PREFIX = '0x60806040819052635c60da1b60e01b';
const used = new Set(JSON.parse(fs.readFileSync('pools-matched.json','utf8')).matched.map(x=>x[0]));
const rows = [];
const CONC = 20;
async function one(n) {
  const a = getContractAddress({ from: DEPLOYER, nonce: BigInt(n) }).toLowerCase();
  let code = '0x';
  try { code = await rpc('eth_getCode', [a, 'latest']); } catch (e) { code = 'ERR'; }
  const len = (code.length - 2) / 2;
  let kind = len === 0 ? 'EMPTY' : code.startsWith(BEACON_PREFIX) ? 'BEACON_POOL' : `other(${len})`;
  return { n, a, len, kind, used: used.has(a) };
}
for (let base = 0; base <= 900; base += CONC) {
  const batch = await Promise.all(Array.from({length: CONC}, (_, i) => base + i).filter(n => n <= 900).map(one));
  rows.push(...batch);
}
fs.writeFileSync('create-space.json', JSON.stringify(rows, null, 1));
const tally = {};
for (const r of rows) tally[r.kind] = (tally[r.kind]||0)+1;
console.log('KIND TALLY over n=0..900:', JSON.stringify(tally));
const pools = rows.filter(r=>r.kind==='BEACON_POOL');
console.log(`BEACON_POOL count=${pools.length}  used=${pools.filter(p=>p.used).length}  UNUSED(pre-deployed!)=${pools.filter(p=>!p.used).length}`);
console.log('pool nonce range:', pools.length? `${pools[0].n}..${pools[pools.length-1].n}`:'-');
const unusedPools = pools.filter(p=>!p.used);
console.log('unused pool nonces:', unusedPools.map(p=>p.n).join(','));
// what occupies odd nonces?
const others = rows.filter(r=>r.kind.startsWith('other'));
const otherLens = {}; for(const o of others) otherLens[r0(o.kind)]=(otherLens[r0(o.kind)]||0)+1;
function r0(k){return k;}
console.log('non-pool contract kinds:', JSON.stringify(otherLens));
console.log('sample odd nonces:', rows.filter(r=>r.n%2===1&&r.len>0).slice(0,6).map(r=>`${r.n}:${r.kind}`).join(' '));
const firstEmpty = rows.find(r=>r.kind==='EMPTY');
console.log('first EMPTY nonce:', firstEmpty? firstEmpty.n : 'none');
const lastNonEmpty = [...rows].reverse().find(r=>r.len>0);
console.log('last non-empty nonce:', lastNonEmpty? `${lastNonEmpty.n} (${lastNonEmpty.kind})`:'-');
