// STEP 2b-ii: STEP 2b showed every owner (EOA and contract alike) stops at the same
// permission gate OnlyApprovedContracts(). That proves no contract-specific early
// rejection, but it does NOT reach the allowance/funds check for EITHER owner class.
//
// To see what lies BEYOND the permission gate, synthesise the grant: trace
// setOperatorApprovalForPool(livePool, OPERATOR, SELS, true) sent FROM the prospective
// owner, capture the registry's storage diff, then replay the order call with that diff
// applied to the registry as a state override. The pool's cross-contract read of the
// registry sees the override, so the gate opens and execution continues to whatever
// check is next. Do it for an EOA owner and a Safe owner and compare.
//
// READ-ONLY: debug_traceCall + eth_call with state overrides. Nothing broadcast.
import { encodeFunctionData } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { SomniaMarkets, binaryPoolWriteAbi, ORDER_TYPE, SELF_MATCHING_OPTION,
         ZERO_ADDRESS } from '@somnia-chain/markets-sdk';
import { TESTNET_CFG, MAINNET_CFG, TESTNET_RPC, MAINNET_RPC, MAINNET_POOLS,
         OPERATOR_REGISTRY, OPERATOR_KEY } from './config.mjs';
import { snapPriceToTick } from './tickmath.mjs';
import fs from 'node:fs';

const ERRMAP = JSON.parse(fs.readFileSync('error-selectors.json', 'utf8'));
const dec = (d) => {
  if (!d) return 'NO REVERT DATA';
  if (d === '0x') return 'EMPTY 0x <-- not dispatched';
  const s = d.slice(0, 10).toLowerCase(), named = ERRMAP[s];
  let o = `${s} = ${named ?? 'UNKNOWN'}`;
  if (named && d.length > 10) {
    const t = named.slice(named.indexOf('(') + 1, -1).split(',').filter(Boolean);
    const w = d.slice(10).match(/.{64}/g) || [];
    o += `  ( ${w.map((x, i) => (t[i] === 'address' ? `address=0x${x.slice(24)}` : `${t[i] ?? '?'}=${BigInt('0x' + x)}`)).join(', ')} )`;
  }
  return o;
};
const grab = (j) => {
  if (!j?.error) return null;
  for (const c of [j.error.data, j.error.data?.data, j.error.message]) {
    if (typeof c === 'string') { const m = c.match(/0x[0-9a-fA-F]{8,}/); if (m) return m[0];
      if (/^0x$/.test(c.trim())) return '0x'; }
  }
  return null;
};
const call = async (rpc, method, params) => {
  const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
};

const REG_ABI = [{ name: 'setOperatorApprovalForPool', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ type: 'address' }, { type: 'address' }, { type: 'bytes4[]' }, { type: 'bool' }], outputs: [] }];
const SELS = ['0x5d97c566', '0xe37b444b', '0x364c2587'];
const OPERATOR = privateKeyToAccount(OPERATOR_KEY || generatePrivateKey()).address;
const EOA_OWNER = privateKeyToAccount('0x' + '11'.repeat(32)).address;
const SAFE = '0xdddd000000000000000000000000000000000004';
const SAFE_SINGLETON = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552';

async function run(label, cfg, rpc, reg, pool, decimals, marketInfo) {
  console.log('\n' + '='.repeat(76));
  console.log(`### ${label}\n    pool=${pool} registry=${reg}`);
  const res = { label, pool, registry: reg, operator: OPERATOR, owners: {} };

  const ex = new SomniaMarkets(cfg);
  const bp = await ex.client.getBinaryBookParams(pool);
  const tick = BigInt(bp.tickSize), minQ = BigInt(bp.minQuantity);
  const priceOn = snapPriceToTick(0.62, tick, decimals);
  const expireNs = marketInfo ? BigInt(marketInfo.expiry) * 1_000_000_000n
    : BigInt(Math.floor(Date.now() / 1000) + 300) * 1_000_000_000n;

  const safeCode = (await call(rpc, 'eth_getCode', [SAFE_SINGLETON, 'latest'])).result;

  for (const [name, owner, extraOverride] of [
    ['EOA owner', EOA_OWNER, {}],
    ['Safe owner (real Safe 1.3.0 code)', SAFE, { [SAFE]: { code: safeCode } }],
  ]) {
    const r = { owner, name };
    // 1) synthesise the grant from this owner on THIS live pool
    const grant = encodeFunctionData({ abi: REG_ABI, functionName: 'setOperatorApprovalForPool',
      args: [pool, OPERATOR, SELS, true] });
    const t = await call(rpc, 'debug_traceCall', [
      { from: owner, to: reg, data: grant, gas: '0x2000000' }, 'latest',
      { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
    const storage = (t.result?.post?.[reg.toLowerCase()] || {}).storage || {};
    r.grantSlots = Object.keys(storage).length;
    r.grantSlotsSetToOne = Object.values(storage).filter(x => BigInt(x) === 1n).length;
    if (t.error) r.grantTraceError = JSON.stringify(t.error).slice(0, 200);

    // 2) replay the order with the grant applied to the registry
    const data = encodeFunctionData({ abi: binaryPoolWriteAbi, functionName: 'placeBinaryOrderFor',
      args: [owner, 0, priceOn, minQ * 10n, expireNs, ORDER_TYPE.LIMIT,
             SELF_MATCHING_OPTION.CANCEL_TAKER, ZERO_ADDRESS, 0n, 0n] });
    const overrides = { [reg]: { stateDiff: storage }, ...extraOverride };
    const j = await call(rpc, 'eth_call', [{ from: OPERATOR, to: pool, data }, 'latest', overrides]);
    r.withGrant = { raw: grab(j), decoded: j.error ? dec(grab(j)) : `NO REVERT ${j.result}` };

    // 3) and without the grant, for contrast
    const j2 = await call(rpc, 'eth_call', [{ from: OPERATOR, to: pool, data }, 'latest', extraOverride]);
    r.withoutGrant = { raw: grab(j2), decoded: j2.error ? dec(grab(j2)) : `NO REVERT ${j2.result}` };

    r.gateOpened = r.withGrant.raw !== r.withoutGrant.raw;
    res.owners[name] = r;
    console.log(`\n  [${name}] ${owner}`);
    console.log(`    grant slots=${r.grantSlots} ones=${r.grantSlotsSetToOne}`);
    console.log(`    WITHOUT grant -> ${r.withoutGrant.decoded}`);
    console.log(`    WITH    grant -> ${r.withGrant.decoded}`);
    console.log(`    permission gate opened by the grant: ${r.gateOpened}`);
  }

  const a = res.owners['EOA owner'].withGrant.raw;
  const b = res.owners['Safe owner (real Safe 1.3.0 code)'].withGrant.raw;
  res.identicalBeyondGate = a === b;
  res.verdict = a === b
    ? `IDENTICAL beyond the permission gate: EOA and Safe owners both -> ${dec(a)}`
    : `DIVERGENT beyond the gate: EOA -> ${dec(a)} ; Safe -> ${dec(b)}`;
  console.log(`\n  VERDICT: ${res.verdict}`);
  return res;
}

const out = {};
try {
  const tex = new SomniaMarkets(TESTNET_CFG);
  const live = await tex.client.listLiveBinaryMarkets();
  const m = live.find(x => x.status === 'Trading') ?? live[0];
  out.testnet = await run('TESTNET (Shannon 50312, 6 dec)', TESTNET_CFG, TESTNET_RPC,
    OPERATOR_REGISTRY.testnet, m.poolAddress, m.quoteDecimals, m);
} catch (e) { out.testnetError = String(e.message); console.log('testnet failed:', e.message); }
try {
  out.mainnetETH = await run('MAINNET (5031, 18 dec) ETH pool', MAINNET_CFG, MAINNET_RPC,
    OPERATOR_REGISTRY.mainnet, MAINNET_POOLS.ETH, 18, null);
} catch (e) { out.mainnetError = String(e.message); console.log('mainnet failed:', e.message); }

fs.writeFileSync('STEP2B-II-RESULT.json', JSON.stringify(out, null, 2));
console.log('\n-> wrote STEP2B-II-RESULT.json');
process.exit(0);
