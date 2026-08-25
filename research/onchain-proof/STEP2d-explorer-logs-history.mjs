// STEP 2d: three read-only checks on the OnlyApprovedContracts gate.
//  1) is the beacon implementation source-verified on a Somnia explorer?
//  2) all log topics ever emitted by pool / beacon / implementation -> admin-shaped event?
//  3) ANY historically SUCCESSFUL placeBinaryOrderFor (0x5d97c566) tx -> read its `from`.
// READ-ONLY. No key, no broadcast.
import fs from 'node:fs';
const J = async (url, opts) => { const r = await fetch(url, opts); const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, text: t.slice(0, 300) }; } };
const rpc = async (url, method, params) => (await J(url, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json;

const MAINNET = 'https://api.infra.mainnet.somnia.network/';
const TESTNET = 'https://api.infra.testnet.somnia.network';
const IMPL = '0x48e523c9f22f98548d263f0ad444d732e5202c0e';
const BEACON = '0x85c01b5ef4f4ed59cac69749565e309f01b14dbc';
const SEL_FOR = '0x5d97c566', SEL_SELF = '0x718c2d4d';
// long-lived mainnet binary pools (hot list) + the beacon/impl
const HOT = ['0xd22908ed947495d4d3dac8c75e75a5cf495ff736','0x39b910486dbc82510d0990caa8b4af05da864bb4',
  '0x3a7be3355ca90e94efa38a7e86abe98ba5b98a75','0xa475e7cff65bd47c3a0783d071e7075e035048a8',
  '0x7539bfac347f92534462ef1f4dca3f1b8b1dc998','0x363deb12f640de39b0575d158325dad098ba0d02',
  '0x68af9113c89acdbd0377f20b33b22ba8bf5e8eb3','0x843ca845bbad0db0954700264901de5e451940ae'];
const out = { checks: {} };

// ============ 1) explorer / verified source =================================
console.log('=== 1) explorer probe + verified-source lookup ===');
const HOSTS = [
  ['mainnet', 'https://explorer.somnia.network'],
  ['mainnet', 'https://somnia.blockscout.com'],
  ['mainnet', 'https://mainnet.somnia.w3us.site'],
  ['testnet', 'https://shannon-explorer.somnia.network'],
  ['testnet', 'https://somnia-testnet.socialscan.io'],
  ['testnet', 'https://somnia-devnet.socialscan.io'],
];
out.checks.explorer = [];
for (const [net, host] of HOSTS) {
  const r = await J(`${host}/api?module=contract&action=getsourcecode&address=${IMPL}`).catch(e => ({ err: String(e.message) }));
  const rec = { net, host, httpStatus: r?.status, err: r?.err };
  const res = r?.json?.result;
  if (Array.isArray(res) && res[0]) {
    rec.contractName = res[0].ContractName || '';
    rec.hasSource = !!(res[0].SourceCode && res[0].SourceCode.length > 0);
    rec.sourceLen = (res[0].SourceCode || '').length;
    rec.abiLen = (res[0].ABI || '').length;
  } else if (r?.json) { rec.message = JSON.stringify(r.json).slice(0, 160); }
  else if (r?.text) { rec.body = r.text.slice(0, 120); }
  out.checks.explorer.push(rec);
  console.log(`  ${host.padEnd(42)} http=${rec.httpStatus ?? 'ERR'} name=${rec.contractName ?? '-'} source=${rec.hasSource ?? '-'}${rec.sourceLen ? ' len=' + rec.sourceLen : ''}`);
}
const verified = out.checks.explorer.find(e => e.hasSource);
out.checks.verifiedFound = !!verified;
if (verified) {
  console.log(`  VERIFIED SOURCE FOUND at ${verified.host} (${verified.contractName}, ${verified.sourceLen} chars)`);
  const r = await J(`${verified.host}/api?module=contract&action=getsourcecode&address=${IMPL}`);
  fs.writeFileSync('STEP2D-IMPL-SOURCE.json', JSON.stringify(r.json, null, 2));
  console.log('  -> wrote STEP2D-IMPL-SOURCE.json');
} else console.log('  no verified source at any probed host');

// ============ 2) all log topics from pool / beacon / impl ====================
console.log('\n=== 2) log-topic histogram for beacon / impl / hot pools (mainnet) ===');
out.checks.logs = {};
async function topics(addr, url = MAINNET) {
  const r = await rpc(url, 'eth_getLogs', [{ address: addr, fromBlock: '0x0', toBlock: 'latest' }]);
  if (r.error) return { error: JSON.stringify(r.error).slice(0, 200) };
  const hist = {};
  for (const l of r.result) { const t = l.topics?.[0] ?? '(anonymous)'; hist[t] = (hist[t] || 0) + 1; }
  return { count: r.result.length, topics: hist,
    sampleTxByTopic: Object.fromEntries(Object.keys(hist).map(t =>
      [t, r.result.find(l => (l.topics?.[0] ?? '(anonymous)') === t)?.transactionHash])) };
}
for (const [name, addr] of [['beacon', BEACON], ['implementation', IMPL], ['hot pool BTC', HOT[0]], ['hot pool ETH', HOT[1]]]) {
  const t = await topics(addr);
  out.checks.logs[name] = { addr, ...t };
  if (t.error) { console.log(`  ${name.padEnd(16)} ${addr} ERROR ${t.error}`); continue; }
  const entries = Object.entries(t.topics).sort((a, b) => a[1] - b[1]);
  console.log(`  ${name.padEnd(16)} ${addr} logs=${t.count} distinctTopics=${entries.length}`);
  entries.forEach(([tp, n]) => console.log(`      ${n.toString().padStart(6)}x ${tp}`));
}

// ============ 3) any SUCCESSFUL placeBinaryOrderFor, ever ===================
console.log('\n=== 3) hunt a historically SUCCESSFUL placeBinaryOrderFor (0x5d97c566) ===');
out.checks.orderFor = { scanned: [], forFound: [], selfFound: [] };
let txBudget = 600;
for (const pool of HOT) {
  if (txBudget <= 0) break;
  const r = await rpc(MAINNET, 'eth_getLogs', [{ address: pool, fromBlock: '0x0', toBlock: 'latest' }]);
  if (r.error) { out.checks.orderFor.scanned.push({ pool, error: JSON.stringify(r.error).slice(0, 150) });
    console.log(`  ${pool} getLogs ERROR`); continue; }
  const hashes = [...new Set(r.result.map(l => l.transactionHash))];
  const take = hashes.slice(0, Math.min(hashes.length, txBudget));
  txBudget -= take.length;
  let nFor = 0, nSelf = 0, nOther = 0;
  for (const h of take) {
    const tx = (await rpc(MAINNET, 'eth_getTransactionByHash', [h])).result;
    if (!tx?.input) continue;
    const sel = tx.input.slice(0, 10).toLowerCase();
    if (sel !== SEL_FOR && sel !== SEL_SELF) { nOther++; continue; }
    const rc = (await rpc(MAINNET, 'eth_getTransactionReceipt', [h])).result;
    const ok = rc?.status === '0x1';
    const rec = { pool, hash: h, from: tx.from, to: tx.to, selector: sel, status: rc?.status, success: ok };
    if (sel === SEL_FOR) { nFor++; if (ok) { out.checks.orderFor.forFound.push(rec);
      console.log(`  *** SUCCESS placeBinaryOrderFor ${h} from=${tx.from} pool=${pool}`); } }
    else { nSelf++; if (ok) out.checks.orderFor.selfFound.push(rec); }
  }
  out.checks.orderFor.scanned.push({ pool, logs: r.result.length, uniqueTx: hashes.length,
    inspected: take.length, sawOrderFor: nFor, sawOrderSelf: nSelf, otherSelectors: nOther });
  console.log(`  ${pool} logs=${r.result.length} uniqTx=${hashes.length} inspected=${take.length} 0x5d97c566=${nFor} 0x718c2d4d=${nSelf} other=${nOther}`);
}
out.checks.orderFor.successfulForCount = out.checks.orderFor.forFound.length;
out.checks.orderFor.successfulSelfCount = out.checks.orderFor.selfFound.length;
out.checks.orderFor.distinctForSenders = [...new Set(out.checks.orderFor.forFound.map(x => x.from))];
out.checks.orderFor.distinctSelfSenders = [...new Set(out.checks.orderFor.selfFound.map(x => x.from))].slice(0, 20);
console.log(`\n  successful placeBinaryOrderFor: ${out.checks.orderFor.successfulForCount}`);
console.log(`  successful placeBinaryOrder(self): ${out.checks.orderFor.successfulSelfCount}`);
console.log(`  distinct 0x5d97c566 senders: ${JSON.stringify(out.checks.orderFor.distinctForSenders)}`);

fs.writeFileSync('STEP2D-RESULT.json', JSON.stringify(out, null, 2));
console.log('\n-> wrote STEP2D-RESULT.json');
