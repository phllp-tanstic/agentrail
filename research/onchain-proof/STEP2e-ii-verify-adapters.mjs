// STEP 2e (completion of check 2): the cross-ref surfaced (a) the module's real
// logic is an UNVERIFIED impl behind an ERC1967Proxy, and (b) the pool's only
// internal caller is a PER-POOL adapter, not the module. Before deciding
// "cleanly resolves vs equally opaque", check verification of those newly-found
// contracts and whether the dominant unnamed selectors are indexed publicly.
// READ-ONLY. No key. No new investigation branch — just closing check 2.
import fs from 'node:fs';
import { MAINNET_RPC } from './config.mjs';

const HOST = 'https://explorer.somnia.network';
const ADDRS = {
  'module-impl':  '0xdf87ac5c4760e2f1dd78e054ce0629a26a4ca5ca',
  'adapter-BTC':  '0x42040dc49c2df9fa2e85fb97a342cb4b0de16791',
  'adapter-ETH':  '0x554080c97adb99ddafeee49e7357d1dc07c8518f',
  'keeper-0x2f':  '0xff825f7b605f644a76138659c8bdc1d178e739db',
};
// dominant / notable UNNAMED selectors seen inbound to the module + the pool keeper op
const SELECTORS = ['0x5b1ffcf2', '0x88cb9474', '0x4efe024a', '0xf5b7ba39', '0x3d312f6d',
                   '0x147607c3', '0x8e3aeebc', '0x2f2461cd', '0x5d97c566', '0x718c2d4d'];

const rpc = async (method, params) => (await fetch(MAINNET_RPC, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
const G = async (url) => { try { const r = await fetch(url, { headers: { accept: 'application/json' } });
  const t = await r.text(); try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, text: t.slice(0, 120) }; } }
  catch (e) { return { err: String(e.message) }; } };

const out = { verify: [], selectorDB: {} };

console.log('=== verification + code of newly-surfaced contracts (mainnet) ===');
for (const [label, addr] of Object.entries(ADDRS)) {
  const code = await rpc('eth_getCode', [addr, 'latest']);
  const codeLen = ((code.result || '0x').length - 2) / 2;
  const r = await G(`${HOST}/api/v2/smart-contracts/${addr}`);
  const j = r.json || {};
  const abi = Array.isArray(j.abi) ? j.abi : [];
  const fns = abi.filter(x => x.type === 'function').map(x => x.name);
  const orderFns = fns.filter(n => /order|place|trade|buy|sell|open|mint|bet|stake|position|redeem|match|fill|exec/i.test(n));
  const rec = { label, addr, codeLen, kind: codeLen === 0 ? 'EOA' : 'contract',
    isVerified: j.is_verified ?? false, name: j.name ?? null, fnCount: fns.length, orderRelatedFns: orderFns };
  out.verify.push(rec);
  console.log(`  ${label.padEnd(12)} ${addr} ${rec.kind} codeLen=${codeLen} verified=${rec.isVerified} name=${rec.name ?? '-'} fns=${rec.fnCount}`);
  if (orderFns.length) console.log(`      order-related fns: ${orderFns.join(', ')}`);
  if (j.is_verified || abi.length) { fs.writeFileSync(`STEP2E-ABI-mainnet-${label}.json`, JSON.stringify(j, null, 2));
    console.log(`      -> wrote STEP2E-ABI-mainnet-${label}.json`); }
}

console.log('\n=== public selector DB (openchain) for the unnamed selectors ===');
for (const s of SELECTORS) {
  const r = await G(`https://api.openchain.xyz/signature-database/v1/lookup?function=${s}&filter=false`);
  const hit = r.json?.result?.function?.[s];
  const names = Array.isArray(hit) ? hit.map(h => h.name) : null;
  out.selectorDB[s] = names && names.length ? names : null;
  console.log(`  ${s} -> ${out.selectorDB[s] ? out.selectorDB[s].join(' | ') : 'null (unindexed)'}`);
}

fs.writeFileSync('STEP2E-II-RESULT.json', JSON.stringify(out, null, 2));
console.log('\n-> wrote STEP2E-II-RESULT.json');
process.exit(0);
