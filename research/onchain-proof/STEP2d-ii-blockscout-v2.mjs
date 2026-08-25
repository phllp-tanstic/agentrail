// STEP 2d (second pass): the RPC caps eth_getLogs at 1000 blocks and the explorers
// speak Blockscout v2, not the legacy /api?module= shim. Redo all three checks via
// the v2 REST API, which serves tx history and verified source without block scanning.
// READ-ONLY.
import fs from 'node:fs';
const G = async (url) => {
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    const t = await r.text();
    try { return { ok: r.ok, status: r.status, json: JSON.parse(t) }; }
    catch { return { ok: r.ok, status: r.status, text: t.slice(0, 200) }; }
  } catch (e) { return { ok: false, err: String(e.message) }; }
};

const IMPL = '0x48e523c9f22f98548d263f0ad444d732e5202c0e';
const BEACON = '0x85c01b5ef4f4ed59cac69749565e309f01b14dbc';
const SEL_FOR = '0x5d97c566', SEL_SELF = '0x718c2d4d';
const HOSTS = { mainnet: 'https://explorer.somnia.network', testnet: 'https://shannon-explorer.somnia.network' };
const POOLS = {
  mainnet: ['0xd22908ed947495d4d3dac8c75e75a5cf495ff736', '0x39b910486dbc82510d0990caa8b4af05da864bb4',
            '0x3a7be3355ca90e94efa38a7e86abe98ba5b98a75', '0x843ca845bbad0db0954700264901de5e451940ae'],
};
const out = { api: 'blockscout v2', checks: {} };

// ---------- 1) verified source ----------------------------------------------
console.log('=== 1) verified source via /api/v2/smart-contracts ===');
out.checks.verified = [];
for (const [net, host] of Object.entries(HOSTS)) {
  for (const [label, addr] of [['implementation', IMPL], ['beacon', BEACON]]) {
    const r = await G(`${host}/api/v2/smart-contracts/${addr}`);
    const j = r.json || {};
    const rec = { net, host, label, addr, status: r.status,
      name: j.name ?? null, isVerified: j.is_verified ?? false,
      lang: j.language ?? null, compiler: j.compiler_version ?? null,
      sourceLen: (j.source_code || '').length,
      abiEntries: Array.isArray(j.abi) ? j.abi.length : 0 };
    out.checks.verified.push(rec);
    console.log(`  ${net}/${label.padEnd(15)} http=${r.status} verified=${rec.isVerified} name=${rec.name ?? '-'} srcLen=${rec.sourceLen} abi=${rec.abiEntries}`);
    if (rec.isVerified || rec.sourceLen > 0 || rec.abiEntries > 0) {
      fs.writeFileSync(`STEP2D-SRC-${net}-${label}.json`, JSON.stringify(j, null, 2));
      console.log(`      -> wrote STEP2D-SRC-${net}-${label}.json`);
    }
  }
}
const anyVerified = out.checks.verified.some(v => v.isVerified || v.sourceLen > 0 || v.abiEntries > 0);
out.checks.anyVerified = anyVerified;

// ---------- 3) successful placeBinaryOrderFor, via tx history ----------------
console.log('\n=== 3) tx history: any SUCCESSFUL 0x5d97c566 ? ===');
out.checks.txHistory = [];
const forHits = [], selfHits = [];
for (const pool of POOLS.mainnet) {
  const host = HOSTS.mainnet;
  let url = `${host}/api/v2/addresses/${pool}/transactions?filter=to`;
  let pages = 0, seen = 0, nFor = 0, nSelf = 0, nForOk = 0, nSelfOk = 0;
  const methodHist = {};
  while (url && pages < 4) {
    const r = await G(url);
    if (!r.json?.items) { out.checks.txHistory.push({ pool, error: r.status ?? r.err, body: r.text }); break; }
    for (const tx of r.json.items) {
      seen++;
      const sel = (tx.raw_input || '').slice(0, 10).toLowerCase();
      const ok = tx.status === 'ok' || tx.result === 'success';
      methodHist[sel || '(none)'] = (methodHist[sel || '(none)'] || 0) + 1;
      if (sel === SEL_FOR) { nFor++; if (ok) { nForOk++; forHits.push({ pool, hash: tx.hash, from: tx.from?.hash, status: tx.status, method: tx.method }); } }
      if (sel === SEL_SELF) { nSelf++; if (ok) { nSelfOk++; selfHits.push({ pool, hash: tx.hash, from: tx.from?.hash, status: tx.status }); } }
    }
    pages++;
    const np = r.json.next_page_params;
    url = np ? `${host}/api/v2/addresses/${pool}/transactions?filter=to&` +
      Object.entries(np).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') : null;
  }
  const top = Object.entries(methodHist).sort((a, b) => b[1] - a[1]).slice(0, 6);
  out.checks.txHistory.push({ pool, inspected: seen, pages, sel_5d97c566: nFor, sel_5d97c566_success: nForOk,
    sel_718c2d4d: nSelf, sel_718c2d4d_success: nSelfOk, topSelectors: top });
  console.log(`  ${pool} inspected=${seen} 0x5d97c566=${nFor}(ok ${nForOk}) 0x718c2d4d=${nSelf}(ok ${nSelfOk})`);
  console.log(`      top selectors: ${top.map(([s, n]) => `${s}x${n}`).join('  ')}`);
}
out.checks.successfulOrderFor = forHits;
out.checks.successfulOrderSelf = selfHits.slice(0, 10);
out.checks.distinctForSenders = [...new Set(forHits.map(h => h.from))];
out.checks.distinctSelfSenders = [...new Set(selfHits.map(h => h.from))].slice(0, 15);
console.log(`\n  SUCCESSFUL 0x5d97c566 txs: ${forHits.length}`);
if (forHits.length) forHits.slice(0, 10).forEach(h => console.log(`    ${h.hash} from=${h.from}`));
console.log(`  SUCCESSFUL 0x718c2d4d (self) txs: ${selfHits.length}; distinct senders: ${out.checks.distinctSelfSenders.length}`);

// ---------- 2) admin-shaped events on beacon / impl / pool -------------------
console.log('\n=== 2) log topics via /api/v2/addresses/{addr}/logs ===');
out.checks.eventTopics = [];
for (const [label, addr] of [['beacon', BEACON], ['implementation', IMPL],
                             ['hot pool BTC', POOLS.mainnet[0]], ['hot pool ETH', POOLS.mainnet[1]]]) {
  const r = await G(`${HOSTS.mainnet}/api/v2/addresses/${addr}/logs`);
  const items = r.json?.items;
  if (!Array.isArray(items)) { out.checks.eventTopics.push({ label, addr, error: r.status ?? r.err });
    console.log(`  ${label.padEnd(15)} http=${r.status} (no items)`); continue; }
  const hist = {};
  for (const l of items) { const t = l.topics?.[0] ?? '(anon)';
    hist[t] = hist[t] || { n: 0, decoded: l.decoded?.method_call ?? null }; hist[t].n++; }
  const entries = Object.entries(hist).sort((a, b) => a[1].n - b[1].n);
  out.checks.eventTopics.push({ label, addr, sampled: items.length,
    topics: entries.map(([t, v]) => ({ topic0: t, count: v.n, decoded: v.decoded })) });
  console.log(`  ${label.padEnd(15)} sampled=${items.length} distinct=${entries.length}`);
  entries.forEach(([t, v]) => console.log(`      ${String(v.n).padStart(4)}x ${t} ${v.decoded ?? ''}`));
}

fs.writeFileSync('STEP2D-RESULT-V2.json', JSON.stringify(out, null, 2));
console.log('\n-> wrote STEP2D-RESULT-V2.json');
