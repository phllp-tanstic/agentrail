// PHASE A prep: (1) can we mint/faucet tUSDC?  (2) which SHORT-expiry market has book depth?
import * as SDK from '@somnia-chain/markets-sdk';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, http, erc20Abi, encodeFunctionData, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = 'https://api.infra.testnet.somnia.network';
const INDEXER = 'https://dev.smk.somnia.host/v1/graphql';
const A = SDK.SOMNIA_TESTNET_ADDRESSES;
const owner = privateKeyToAccount(process.env.AGENTRAIL_OWNER_KEY);
const pc = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
const COLL = A.collateral;

console.log('owner:', owner.address);

// ---------- 1. Blockscout v2 verified ABI for the collateral token ----------
console.log('\n=== collateral contract verification (Blockscout v2) ===');
try {
  const r = await fetch(`https://shannon-explorer.somnia.network/api/v2/smart-contracts/${COLL}`);
  const j = await r.json();
  console.log('is_verified:', j.is_verified, '| name:', j.name);
  if (j.abi) {
    const fns = j.abi.filter(x => x.type === 'function')
      .map(x => `${x.name}(${(x.inputs || []).map(i => i.type).join(',')}) ${x.stateMutability}`);
    console.log('functions:\n  ' + fns.join('\n  '));
  }
} catch (e) { console.log('explorer ERR', e.message); }

// ---------- 2. brute-force common faucet/mint selectors by eth_call from owner ----------
console.log('\n=== faucet/mint selector probes (eth_call from owner, nothing broadcast) ===');
const AMT = 1000_000000n; // 1000 tUSDC at 6 dec
const cands = [
  ['mint(address,uint256)', [owner.address, AMT]],
  ['mint(uint256)', [AMT]],
  ['mint()', []],
  ['faucet()', []],
  ['faucet(uint256)', [AMT]],
  ['drip()', []],
  ['claim()', []],
  ['claimFaucet()', []],
  ['getFreeTokens()', []],
  ['mintTo(address,uint256)', [owner.address, AMT]],
];
for (const [sig, args] of cands) {
  const name = sig.slice(0, sig.indexOf('('));
  const types = sig.slice(sig.indexOf('(') + 1, -1).split(',').filter(Boolean);
  const abi = [{ type: 'function', name, stateMutability: 'nonpayable',
                 inputs: types.map((t, i) => ({ name: `a${i}`, type: t })), outputs: [] }];
  const data = encodeFunctionData({ abi, functionName: name, args });
  const body = { jsonrpc: '2.0', id: 1, method: 'eth_call',
                 params: [{ from: owner.address, to: COLL, data }, 'latest'] };
  const res = await (await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const ok = !res.error;
  console.log(`  ${toFunctionSelector(sig)} ${sig.padEnd(26)} -> ${ok ? 'NO REVERT ***CANDIDATE***' : (res.error.data ?? res.error.message).toString().slice(0, 90)}`);
}

// ---------- 3. book depth across every live market, sorted by time-to-expiry ----------
console.log('\n=== live markets: time-to-expiry vs book depth ===');
const ex = new SDK.SomniaMarkets({ chain: somniaShannon, rpcUrl: RPC, indexerUrl: INDEXER, addresses: A });
const live = await ex.client.listLiveBinaryMarkets();
const now = Math.floor(Date.now() / 1000);
const rows = [];
for (const m of live) {
  let ob = null;
  try { ob = await ex.client.getBinaryOrderBook(m.poolAddress); } catch (e) { /* ignore */ }
  const bestAsk = ob?.yesAsks?.[0];
  rows.push({
    marketId: m.marketId, asset: m.asset, pool: m.poolAddress,
    T: Number(m.expiry) - now, intervalSec: m.intervalSec, status: m.status,
    yesAsks: ob?.yesAsks?.length ?? 0, yesBids: ob?.yesBids?.length ?? 0,
    bestAskPrice: bestAsk?.price ?? null, bestAskQty: bestAsk?.quantity ?? null,
    operatorId: m.operatorId, venueId: m.venueId,
  });
}
rows.sort((a, b) => a.T - b.T);
for (const r of rows) {
  console.log(`  T-${String(r.T).padStart(6)}s int=${String(r.intervalSec).padStart(5)} ${r.asset} ${r.pool} asks=${r.yesAsks} bids=${r.yesBids} bestAsk=${r.bestAskPrice}@${r.bestAskQty}`);
}
const usable = rows.filter(r => r.yesAsks > 0);
console.log('\nmarkets WITH yes-ask depth:', usable.length, '| shortest such window: T-' + (usable[0]?.T ?? 'none') + 's int=' + usable[0]?.intervalSec);
process.exit(0);
