// STEP 2e (check 2): is binaryMarketsModule the real order entry point?
//   A. code + EIP-1967 proxy check for the module (both nets)
//   B. VERIFIED SOURCE / ABI for the module via blockscout v2 (the clean-resolution path)
//   C. module inbound tx history: selector histogram, success, DISTINCT SENDERS
//   D. senders of the top-level 0x2f2461cd txs on BTC/ETH pools
//   E. pool INTERNAL-tx callers: does the module sit above the pool?
//   then cross-reference C vs D vs module-addr vs E.
// READ-ONLY. No key, no eth_call simulation, no name-guessing.
import fs from 'node:fs';
import { CORE, MAINNET_POOLS, MAINNET_RPC, TESTNET_RPC, OPERATOR_REGISTRY } from './config.mjs';

const SEL_2F = '0x2f2461cd', SEL_FOR = '0x5d97c566', SEL_SELF = '0x718c2d4d';
const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const MODULE = CORE.binaryMarketsModule.toLowerCase();
const HOSTS = { mainnet: 'https://explorer.somnia.network', testnet: 'https://shannon-explorer.somnia.network' };
const POOLS = { BTC: MAINNET_POOLS.BTC.toLowerCase(), ETH: MAINNET_POOLS.ETH.toLowerCase() };
const NAMES = {
  [MODULE]: 'binaryMarketsModule',
  [CORE.outcomeToken6909.toLowerCase()]: 'outcomeToken6909',
  [CORE.binarySettlement.toLowerCase()]: 'binarySettlement',
  [CORE.oracleHub.toLowerCase()]: 'oracleHub',
  [OPERATOR_REGISTRY.mainnet.toLowerCase()]: 'OperatorPermissionsRegistry(mainnet)',
  [POOLS.BTC]: 'pool BTC', [POOLS.ETH]: 'pool ETH',
};
const nm = (a) => NAMES[(a || '').toLowerCase()] ?? '';

const rpc = async (url, method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
};
const G = async (url) => {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    const t = await r.text();
    try { return { ok: r.ok, status: r.status, json: JSON.parse(t) }; }
    catch { return { ok: r.ok, status: r.status, text: t.slice(0, 200) }; }
  } catch (e) { return { ok: false, err: String(e.message) }; }
};
// page a blockscout v2 list endpoint, up to `maxPages`
async function page(host, path, maxPages) {
  const items = []; let np = null, pages = 0;
  do {
    const qs = np ? '&' + Object.entries(np).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : '';
    const r = await G(`${host}${path}${qs}`);
    if (!r.json?.items) { if (pages === 0) items._err = r.status ?? r.err ?? r.text; break; }
    items.push(...r.json.items); pages++; np = r.json.next_page_params;
  } while (np && pages < maxPages);
  items._pages = pages;
  return items;
}
const sel = (tx) => (tx.raw_input || tx.input || '').slice(0, 10).toLowerCase();
const ok = (tx) => tx.status === 'ok' || tx.result === 'success';

const out = { selectorDB: { note: 'openchain+4byte both return null for 0x2f2461cd AND 0x5d97c566 (custom, unindexed)' } };

// ============ A. module code + proxy check ==================================
console.log('=== A. module code + EIP-1967 proxy check ===');
out.moduleCode = {};
for (const [net, url] of [['mainnet', MAINNET_RPC], ['testnet', TESTNET_RPC]]) {
  try {
    const c = await rpc(url, 'eth_getCode', [MODULE, 'latest']);
    const hex = (c.result || '0x').toLowerCase();
    const codeLen = (hex.length - 2) / 2;
    const slot = await rpc(url, 'eth_getStorageAt', [MODULE, EIP1967_IMPL, 'latest']);
    const raw = slot.result || '0x';
    const impl = raw && raw !== '0x' && !/^0x0+$/.test(raw) ? '0x' + raw.slice(-40) : null;
    out.moduleCode[net] = { codeLen, eip1967Impl: impl };
    console.log(`  ${net}: codeLen=${codeLen}  EIP-1967 impl=${impl ?? '(none / not a 1967 proxy)'}`);
  } catch (e) { out.moduleCode[net] = { err: String(e.message) }; console.log(`  ${net}: ERR ${e.message}`); }
}

// ============ B. verified source / ABI for the module =======================
console.log('\n=== B. module verified source / ABI (blockscout v2) ===');
out.moduleVerify = [];
for (const [net, host] of Object.entries(HOSTS)) {
  const targets = [['module', MODULE]];
  const impl = out.moduleCode[net]?.eip1967Impl;
  if (impl) targets.push(['module-impl', impl]);
  for (const [label, addr] of targets) {
    const r = await G(`${host}/api/v2/smart-contracts/${addr}`);
    const j = r.json || {};
    const abi = Array.isArray(j.abi) ? j.abi : [];
    const fns = abi.filter(x => x.type === 'function').map(x => x.name);
    const orderFns = fns.filter(n => /order|place|trade|buy|sell|open|mint|bet|stake|position|redeem|settle|resolve/i.test(n));
    const rec = { net, label, addr, status: r.status, isVerified: j.is_verified ?? false, name: j.name ?? null,
      proxyType: j.proxy_type ?? null,
      implementations: (j.implementations || []).map(i => ({ address: i.address, name: i.name })),
      fnCount: fns.length, orderRelatedFns: orderFns };
    out.moduleVerify.push(rec);
    console.log(`  ${net}/${label.padEnd(11)} http=${r.status} verified=${rec.isVerified} name=${rec.name ?? '-'} proxy=${rec.proxyType ?? '-'} fns=${rec.fnCount}`);
    if (rec.implementations.length) console.log(`      implementations: ${rec.implementations.map(i => `${i.address}${i.name ? ' (' + i.name + ')' : ''}`).join(', ')}`);
    if (orderFns.length) console.log(`      order-related fns: ${orderFns.join(', ')}`);
    if (rec.isVerified || abi.length) { fs.writeFileSync(`STEP2E-ABI-${net}-${label}.json`, JSON.stringify(j, null, 2));
      console.log(`      -> wrote STEP2E-ABI-${net}-${label}.json (${abi.length} abi entries)`); }
  }
}

// ============ C. module inbound tx history ==================================
console.log('\n=== C. module inbound tx history (filter=to) ===');
out.moduleInbound = {};
const moduleSenders = {};   // net -> Set(from)
for (const [net, host] of Object.entries(HOSTS)) {
  const txs = await page(host, `/api/v2/addresses/${MODULE}/transactions?filter=to`, 6);
  if (txs._err && txs.length === 0) { out.moduleInbound[net] = { error: txs._err }; console.log(`  ${net}: ERR ${txs._err}`); continue; }
  const selHist = {}, methodHist = {}, senders = new Set(); const sampleInputs = {};
  let nOk = 0;
  for (const tx of txs) {
    const s = sel(tx) || '(none)';
    selHist[s] = (selHist[s] || 0) + 1;
    if (tx.method) methodHist[tx.method] = (methodHist[tx.method] || 0) + 1;
    if (tx.from?.hash) senders.add(tx.from.hash.toLowerCase());
    if (ok(tx)) nOk++;
    if (!sampleInputs[s]) sampleInputs[s] = { hash: tx.hash, from: tx.from?.hash, method: tx.method ?? null, status: tx.status, input: (tx.raw_input || tx.input || '').slice(0, 138) };
  }
  moduleSenders[net] = senders;
  const top = Object.entries(selHist).sort((a, b) => b[1] - a[1]).slice(0, 10);
  out.moduleInbound[net] = { inspected: txs.length, pages: txs._pages, successful: nOk,
    distinctSenders: senders.size, topSelectors: top, methodNames: methodHist,
    sampleSenders: [...senders].slice(0, 12), sampleInputBySelector: sampleInputs };
  console.log(`  ${net}: inspected=${txs.length} pages=${txs._pages} ok=${nOk} distinctSenders=${senders.size}`);
  console.log(`      top selectors: ${top.map(([s, n]) => `${s}x${n}`).join('  ')}`);
  if (Object.keys(methodHist).length) console.log(`      decoded methods: ${Object.entries(methodHist).map(([m, n]) => `${m}x${n}`).join('  ')}`);
  console.log(`      has 0x5d97c566(For)? ${!!selHist[SEL_FOR]}   0x718c2d4d(self)? ${!!selHist[SEL_SELF]}   0x2f2461cd? ${!!selHist[SEL_2F]}`);
}

// ============ D. senders of top-level 0x2f2461cd pool txs ====================
console.log('\n=== D. senders of top-level 0x2f2461cd txs on BTC/ETH pools (mainnet) ===');
out.poolSenders = {};
const poolSenderUnion = new Set();
for (const [label, pool] of Object.entries(POOLS)) {
  const txs = await page(HOSTS.mainnet, `/api/v2/addresses/${pool}/transactions?filter=to`, 4);
  if (txs._err && txs.length === 0) { out.poolSenders[label] = { error: txs._err }; console.log(`  ${label}: ERR ${txs._err}`); continue; }
  const senders2f = new Set(); let n2f = 0; let sampleMethod = null; let sampleInput = null;
  for (const tx of txs) {
    if (sel(tx) === SEL_2F) { n2f++; if (tx.from?.hash) senders2f.add(tx.from.hash.toLowerCase());
      if (!sampleInput) { sampleMethod = tx.method ?? null; sampleInput = (tx.raw_input || tx.input || '').slice(0, 138); } }
  }
  senders2f.forEach(s => poolSenderUnion.add(s));
  out.poolSenders[label] = { pool, inspected: txs.length, tx_2f: n2f, distinctSenders: senders2f.size,
    senders: [...senders2f].map(s => ({ addr: s, name: nm(s) })), decodedMethod: sampleMethod, sampleInput };
  console.log(`  ${label} ${pool}: 0x2f2461cd txs=${n2f} distinctSenders=${senders2f.size} method=${sampleMethod ?? '-'}`);
  [...senders2f].forEach(s => console.log(`      from ${s} ${nm(s)}`));
}

// ============ E. pool INTERNAL-tx callers ===================================
console.log('\n=== E. pool internal-tx callers: who calls the pool from inside a tx? ===');
out.poolInternalCallers = {};
for (const [label, pool] of Object.entries(POOLS)) {
  const its = await page(HOSTS.mainnet, `/api/v2/addresses/${pool}/internal-transactions?filter=to`, 3);
  if (its._err && its.length === 0) { out.poolInternalCallers[label] = { error: its._err }; console.log(`  ${label}: ERR ${its._err}`); continue; }
  const callers = {};
  for (const it of its) { const f = (it.from?.hash || '').toLowerCase(); if (f) callers[f] = (callers[f] || 0) + 1; }
  const sorted = Object.entries(callers).sort((a, b) => b[1] - a[1]).slice(0, 10);
  out.poolInternalCallers[label] = { pool, inspected: its.length, moduleIsInternalCaller: !!callers[MODULE],
    callers: sorted.map(([a, n]) => ({ addr: a, name: nm(a), count: n })) };
  console.log(`  ${label} ${pool}: internalTxs=${its.length} moduleIsInternalCaller=${!!callers[MODULE]}`);
  sorted.forEach(([a, n]) => console.log(`      ${String(n).padStart(4)}x  ${a} ${nm(a)}`));
}

// ============ cross-reference ===============================================
console.log('\n=== CROSS-REFERENCE ===');
const mSendersAll = new Set([...(moduleSenders.mainnet || []), ...(moduleSenders.testnet || [])]);
const overlap = [...poolSenderUnion].filter(s => mSendersAll.has(s));
out.crossref = {
  moduleAddr: MODULE,
  moduleInPoolTopLevelSenders: poolSenderUnion.has(MODULE),
  moduleIsInternalCallerOfPool: Object.values(out.poolInternalCallers).some(v => v.moduleIsInternalCaller),
  pool2fSenders: [...poolSenderUnion].map(s => ({ addr: s, name: nm(s) })),
  moduleInboundSenderCount: mSendersAll.size,
  senderOverlap_pool2f_vs_moduleInbound: overlap.map(s => ({ addr: s, name: nm(s) })),
};
console.log(`  module address:                         ${MODULE}`);
console.log(`  module in pool top-level 0x2f senders?  ${out.crossref.moduleInPoolTopLevelSenders}`);
console.log(`  module is INTERNAL caller of pool?      ${out.crossref.moduleIsInternalCallerOfPool}`);
console.log(`  distinct pool-0x2f senders:             ${poolSenderUnion.size}`);
console.log(`  distinct module-inbound senders:        ${mSendersAll.size}`);
console.log(`  overlap (same EOA drives both):         ${overlap.length}  ${overlap.map(s => nm(s) || s).join(', ')}`);

fs.writeFileSync('STEP2E-RESULT.json', JSON.stringify(out, null, 2));
console.log('\n-> wrote STEP2E-RESULT.json');
process.exit(0);
