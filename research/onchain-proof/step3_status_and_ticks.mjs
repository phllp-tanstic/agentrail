// STEP 3 + tick discovery: read on-chain market status and the pool's REAL book params
// (tickSize / lotSize / minQuantity) on BOTH testnet and mainnet. READ-ONLY, no key.
import { SomniaMarkets, isBinaryMarket } from '@somnia-chain/markets-sdk';
import { TESTNET_CFG, MAINNET_CFG, MAINNET_POOLS } from './config.mjs';
import fs from 'node:fs';

const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v), 2);

// ---------- TESTNET: pick a fresh live market, gate on on-chain status ----------
const tex = new SomniaMarkets(TESTNET_CFG);
const live = await tex.client.listLiveBinaryMarkets();
const bins = live.filter(isBinaryMarket);
console.log('=== TESTNET live binary markets:', bins.length, '===');
const m = bins.find(x => x.status === 'Trading') ?? bins[0];
console.log('market', m.marketId, 'pool', m.poolAddress, 'asset', m.asset,
            'expiry', m.expiry, 'quoteDecimals', m.quoteDecimals);

console.log('\n--- STEP 3: getMarketOnchain(marketId) status gate ---');
let onchain = null;
try {
  onchain = await tex.client.getMarketOnchain(m.marketId);
  console.log('getMarketOnchain ->', J(onchain));
  const st = onchain.status;
  console.log('status raw =', st, '| typeof', typeof st);
  console.log('GATE status===1 (Trading)?', st === 1, '| status==="Trading"?', st === 'Trading');
  console.log('STEP 3 GATE RESULT:', (st === 1 || st === 'Trading') ? 'OPEN (tradable)' : 'CLOSED');
} catch (e) {
  console.log('getMarketOnchain ERR:', e.message);
}

console.log('\n--- TESTNET getBinaryBookParams (tick discovery) ---');
// NOTE: getBinaryBookParams takes a POSITIONAL address string, NOT an object.
// Passing { pool } throws "pool.toLowerCase is not a function".
let tParams = null;
try {
  tParams = await tex.client.getBinaryBookParams(m.poolAddress);
  console.log(J(tParams));
} catch (e) {
  console.log('getBinaryBookParams ERR:', e.message);
}

// ---------- MAINNET: read real 18-decimal book params from the live pools ----------
console.log('\n=== MAINNET pools (18-decimal ground truth for tick math) ===');
const mex = new SomniaMarkets(MAINNET_CFG);
const mainParams = {};
for (const [name, pool] of Object.entries(MAINNET_POOLS)) {
  try {
    const p = await mex.client.getBinaryBookParams(pool);
    mainParams[name] = { pool, ...p };
    console.log(name, pool, '->', J(p));
  } catch (e) {
    console.log(name, pool, 'ERR:', e.message);
  }
}

fs.writeFileSync('book-params.json', JSON.stringify({
  testnet: { market: m.marketId, pool: m.poolAddress, quoteDecimals: m.quoteDecimals,
             onchainStatus: onchain?.status ?? null, params: tParams },
  mainnet: mainParams,
}, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log('\n-> wrote book-params.json');
process.exit(0);
