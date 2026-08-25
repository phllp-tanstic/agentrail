// ============================================================================
// PART 2 DIAGNOSTIC — full order book depth, both sides, fresh markets.
// READ-ONLY. No key, no signing, no broadcast. Answers exactly one question:
//   is there any REAL resting liquidity on the NO side, at ANY price level?
// ============================================================================
import * as SDK from '@somnia-chain/markets-sdk';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import { formatUnits } from 'viem';
import fs from 'node:fs';

const RPC = 'https://api.infra.testnet.somnia.network';
const INDEXER = 'https://dev.smk.somnia.host/v1/graphql';
const A = SDK.SOMNIA_TESTNET_ADDRESSES;
const T0 = Date.now();
const el = () => `[+${((Date.now() - T0) / 1000).toFixed(1)}s]`;
const L = (...a) => console.log(el(), ...a);
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
const ex = new SDK.SomniaMarkets({ chain: somniaShannon, rpcUrl: RPC, indexerUrl: INDEXER, addresses: A });
const OUT = { probedAt: new Date().toISOString(), markets: [] };

console.log('='.repeat(78));
console.log('PART 2 — ORDER BOOK DEPTH DIAGNOSTIC (read-only)');
console.log('='.repeat(78));

const live = await ex.client.listLiveBinaryMarkets();
const now = Math.floor(Date.now() / 1000);
// NOTE: deliberately NOT filtering on "has noAsks" — that filter is what run 1/2
// used to select markets, and filtering on it here would bias the sample.
const cands = live
  .map(m => ({ m, T: Number(m.expiry) - now, interval: Number(m.intervalSec) }))
  .filter(c => c.interval <= 900 && c.T > 10 && c.T < 300)
  .sort((a, b) => a.interval - b.interval || a.T - b.T)
  .slice(0, 6);
L(`live binary markets: ${live.length} | short-window candidates probed: ${cands.length}`);

const sum = (levels) => (levels ?? []).reduce((a, l) => a + BigInt(l.quantity), 0n);

for (const c of cands) {
  const M = c.m;
  const DEC = Number(M.quoteDecimals);
  const ONE = 10n ** BigInt(DEC);
  console.log('\n' + '-'.repeat(78));
  L(`market ${M.marketId} ${M.asset} interval=${c.interval}s T-${c.T}s pool=${M.poolAddress}`);

  let ob = null, obErr = null;
  try { ob = await ex.client.getBinaryOrderBook(M.poolAddress); }
  catch (e) { obErr = e.shortMessage ?? e.message; }
  if (!ob) { L(`   getBinaryOrderBook FAILED: ${obErr}`); OUT.markets.push({ marketId: M.marketId, obError: obErr }); continue; }

  // 1. what does the book object actually CONTAIN? (full shape, not just asks[0])
  const keys = Object.keys(ob);
  L(`   book keys: ${J(keys)}`);
  const arrKeys = keys.filter(k => Array.isArray(ob[k]));
  L(`   array-valued sides: ${arrKeys.map(k => `${k}[${ob[k].length}]`).join(' ')}`);

  // 2. EVERY level on EVERY side, not just [0]
  const sides = {};
  for (const k of arrKeys) {
    sides[k] = (ob[k] ?? []).map(l => ({ price: String(l.price), qty: String(l.quantity),
      p: formatUnits(BigInt(l.price), DEC), units: formatUnits(BigInt(l.quantity), DEC) }));
    const tot = sum(ob[k]);
    L(`   ${k.padEnd(8)} levels=${String(ob[k].length).padStart(2)} totalQty=${String(tot).padStart(12)} (${formatUnits(tot, DEC)} units)`);
    for (const l of sides[k]) L(`        p=${l.p.padEnd(8)} qty=${l.units}`);
  }

  const totYesAsk = sum(ob.yesAsks), totYesBid = sum(ob.yesBids);
  const totNoAsk = sum(ob.noAsks), totNoBid = sum(ob.noBids);
  L(`   DEPTH TOTALS  yesAsks=${formatUnits(totYesAsk, DEC)}  yesBids=${formatUnits(totYesBid, DEC)}  noAsks=${formatUnits(totNoAsk, DEC)}  noBids=${formatUnits(totNoBid, DEC)}`);
  L(`   NO side has ANY resting depth at ANY price? asks:${totNoAsk > 0n} bids:${totNoBid > 0n}`);

  // 3. MIRROR TEST — is the displayed NO side an independent book, or is it just
  //    the arithmetic complement of the YES side (noAsk price == ONE - yesBid
  //    price, same quantity)? A derived/mirror side would display depth that has
  //    no matchable resting order behind it.
  const mirror = [];
  for (const na of (ob.noAsks ?? [])) {
    const want = ONE - BigInt(na.price);
    const hit = (ob.yesBids ?? []).find(yb => BigInt(yb.price) === want);
    mirror.push({ noAskPrice: String(na.price), noAskQty: String(na.quantity),
      impliedYesBidPrice: String(want), matchedYesBid: hit ? String(hit.price) : null,
      matchedYesBidQty: hit ? String(hit.quantity) : null,
      qtyIdentical: hit ? BigInt(hit.quantity) === BigInt(na.quantity) : null });
  }
  const mirrored = mirror.filter(x => x.matchedYesBid !== null);
  const mirroredExact = mirror.filter(x => x.qtyIdentical === true);
  L(`   MIRROR TEST: ${mirroredExact.length}/${mirror.length} noAsk levels are exactly (ONE - yesBid) with identical qty` +
    ` | price-only matches ${mirrored.length}/${mirror.length}`);
  for (const x of mirror) L(`        noAsk ${x.noAskPrice} -> implies yesBid ${x.impliedYesBidPrice} | found=${x.matchedYesBid} qtyIdentical=${x.qtyIdentical}`);

  OUT.markets.push({ marketId: M.marketId, asset: M.asset, pool: M.poolAddress,
    intervalSec: c.interval, secsToExpiry: c.T, decimals: DEC, bookKeys: keys,
    sides, totals: { yesAsks: String(totYesAsk), yesBids: String(totYesBid),
      noAsks: String(totNoAsk), noBids: String(totNoBid) },
    noSideHasDepth: { asks: totNoAsk > 0n, bids: totNoBid > 0n },
    mirrorTest: { levels: mirror.length, exactMirrors: mirroredExact.length, priceMatches: mirrored.length, detail: mirror } });
}

console.log('\n' + '='.repeat(78));
L('SUMMARY');
for (const m of OUT.markets) {
  if (m.obError) { L(`   ${m.marketId?.slice(0, 10)} BOOK ERROR ${m.obError}`); continue; }
  L(`   ${m.marketId.slice(0, 10)} ${String(m.asset).padEnd(4)} yesAsk=${m.totals.yesAsks.padStart(10)} yesBid=${m.totals.yesBids.padStart(10)} noAsk=${m.totals.noAsks.padStart(10)} noBid=${m.totals.noBids.padStart(10)} | mirror ${m.mirrorTest.exactMirrors}/${m.mirrorTest.levels}`);
}
fs.writeFileSync('build/PART2-DEPTH.json', J(OUT));
L('-> wrote build/PART2-DEPTH.json');
process.exit(0);
