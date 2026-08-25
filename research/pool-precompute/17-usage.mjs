// Find REAL usage of the registry: pull its event logs, and prove whether a global grant
// satisfies the per-pool authorization view.
import { rpc } from './rpc.mjs';
import { keccak256, toHex, encodeFunctionData, decodeFunctionResult } from 'viem';

const REG = '0xE7a190736B6024a4DbafadC04E283075877005ce';
const S = (s) => keccak256(toHex(s));

console.log('=== candidate event topic0s ===');
const EV = {};
for (const e of ['OperatorApprovalSet(address,address,address,bytes4,bool)',
  'OperatorApprovalUpdated(address,address,address,bytes4,bool)',
  'OperatorApprovalForPoolSet(address,address,address,bytes4[],bool)',
  'GlobalOperatorApprovalSet(address,address,bytes4[],bool)',
  'OperatorApprovalGlobalSet(address,address,bytes4[],bool)',
  'ApprovalSet(address,address,address,bytes4,bool)',
  'OperatorApproval(address,address,address,bytes4,bool)']) { EV[S(e)] = e; console.log(' ', S(e), e); }

const latest = parseInt(await rpc('eth_blockNumber'), 16);
console.log('\nlatest block', latest);

// Blockscout is far better for historical logs than range-scanning eth_getLogs on a 393M-block chain.
console.log('\n=== Blockscout: registry logs ===');
let logs = [];
try {
  const r = await fetch(`https://explorer.somnia.network/api/v2/addresses/${REG}/logs`);
  const j = await r.json();
  logs = j.items || [];
  console.log(`items: ${logs.length}`);
  const t0 = {};
  for (const l of logs) t0[l.topics[0]] = (t0[l.topics[0]] || 0) + 1;
  for (const [t, n] of Object.entries(t0)) console.log(`  topic0 ${t} x${n}  ${EV[t] || '(unknown event)'}`);
  for (const l of logs.slice(0, 6)) {
    console.log(`   blk=${l.block_number} tx=${l.transaction_hash}`);
    console.log(`     topics=${JSON.stringify(l.topics)}`);
    console.log(`     data=${(l.data || '').slice(0, 200)}`);
  }
} catch (e) { console.log('logs fetch failed:', e.message); }

console.log('\n=== Blockscout: registry transactions (which selectors do real users call?) ===');
try {
  const r = await fetch(`https://explorer.somnia.network/api/v2/addresses/${REG}/transactions`);
  const j = await r.json();
  const items = j.items || [];
  console.log(`items: ${items.length}`);
  const bySel = {};
  for (const t of items) {
    const sel = (t.raw_input || '').slice(0, 10);
    bySel[sel] = bySel[sel] || { n: 0, froms: new Set(), ex: t.hash };
    bySel[sel].n++; bySel[sel].froms.add((t.from?.hash || '').toLowerCase());
  }
  for (const [sel, v] of Object.entries(bySel))
    console.log(`  ${sel} x${v.n}  uniqueSenders=${v.froms.size}  example=${v.ex}`);
  // keep raw inputs for the global-vs-pool analysis
  const globals = items.filter(t => (t.raw_input || '').startsWith('0x7f1e31ce'));
  const perPool = items.filter(t => (t.raw_input || '').startsWith('0x7bbc67e6'));
  console.log(`\n  setOperatorApprovalGlobal (0x7f1e31ce) txs: ${globals.length}`);
  console.log(`  setOperatorApprovalForPool (0x7bbc67e6) txs: ${perPool.length}`);
  for (const t of globals.slice(0, 4)) {
    console.log(`   GLOBAL tx ${t.hash} from=${t.from?.hash} status=${t.status}`);
    console.log(`     input=${t.raw_input}`);
  }
  for (const t of perPool.slice(0, 3)) {
    console.log(`   PERPOOL tx ${t.hash} from=${t.from?.hash}`);
    console.log(`     input=${(t.raw_input || '').slice(0, 330)}`);
  }
} catch (e) { console.log('tx fetch failed:', e.message); }

console.log('\n=== does the node support eth_call STATE OVERRIDES? (would let us simulate a grant) ===');
try {
  const r = await rpc('eth_call', [{ to: REG, data: '0x8da5cb5b' }, 'latest',
    { [REG]: { balance: '0x1' } }]);
  console.log('  state-override accepted, owner() =', r);
} catch (e) { console.log('  state override ->', String(e.message).slice(0, 180)); }
