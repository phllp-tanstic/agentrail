// STEP 2c: identify the exact SLOAD(s) behind 0x3fb0ba2e OnlyApprovedContracts().
// No overrides anywhere - trace the REAL reverting call as-is.
//   1) callTracer     -> does the pool call OUT to any contract before reverting?
//   2) prestateTracer -> every account + storage slot actually READ during the call
//   3) structLogger    -> the last SLOADs before the REVERT, with slot + depth
//   4) same gate on the plain (non-"For") placeBinaryOrder self path?
// READ-ONLY. Nothing signed, nothing broadcast, no state overrides.
import { encodeFunctionData } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { SomniaMarkets, binaryPoolWriteAbi, ORDER_TYPE, SELF_MATCHING_OPTION,
         ZERO_ADDRESS } from '@somnia-chain/markets-sdk';
import { TESTNET_CFG, MAINNET_CFG, TESTNET_RPC, MAINNET_RPC, MAINNET_POOLS,
         OPERATOR_REGISTRY, CORE, OPERATOR_KEY } from './config.mjs';
import { snapPriceToTick } from './tickmath.mjs';
import fs from 'node:fs';

const ERRMAP = JSON.parse(fs.readFileSync('error-selectors.json', 'utf8'));
const call = async (rpc, method, params) => {
  const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
};
const OPERATOR = privateKeyToAccount(OPERATOR_KEY || generatePrivateKey()).address;
const OWNER = privateKeyToAccount('0x' + '11'.repeat(32)).address;

// every known address, so any traced address can be named
const KNOWN = (net) => ({
  [OPERATOR_REGISTRY[net].toLowerCase()]: `*** OperatorPermissionsRegistry (${net}) ***`,
  [CORE.binaryMarketsModule.toLowerCase()]: 'binaryMarketsModule',
  [CORE.outcomeToken6909.toLowerCase()]: 'outcomeToken6909',
  [CORE.binarySettlement.toLowerCase()]: 'binarySettlement',
  [CORE.oracleHub.toLowerCase()]: 'oracleHub',
  [OPERATOR.toLowerCase()]: 'operator EOA (from)',
  [OWNER.toLowerCase()]: 'owner EOA (arg)',
});

async function analyse(label, cfg, rpc, net, pool, decimals, marketInfo) {
  console.log('\n' + '='.repeat(76));
  console.log(`### ${label}\n    pool=${pool}`);
  const names = KNOWN(net);
  names[pool.toLowerCase()] = 'the POOL itself';
  const REG = OPERATOR_REGISTRY[net];
  const res = { label, pool, registry: REG, net };

  const ex = new SomniaMarkets(cfg);
  const bp = await ex.client.getBinaryBookParams(pool);
  const tick = BigInt(bp.tickSize), minQ = BigInt(bp.minQuantity);
  const priceOn = snapPriceToTick(0.62, tick, decimals);
  const expireNs = marketInfo ? BigInt(marketInfo.expiry) * 1_000_000_000n
    : BigInt(Math.floor(Date.now() / 1000) + 300) * 1_000_000_000n;
  const common = [0, priceOn, minQ * 10n, expireNs, ORDER_TYPE.LIMIT,
                  SELF_MATCHING_OPTION.CANCEL_TAKER, ZERO_ADDRESS, 0n, 0n];
  const dataFor = encodeFunctionData({ abi: binaryPoolWriteAbi,
    functionName: 'placeBinaryOrderFor', args: [OWNER, ...common] });
  const dataSelf = encodeFunctionData({ abi: binaryPoolWriteAbi,
    functionName: 'placeBinaryOrder', args: common });
  res.calldataFor = dataFor; res.calldataSelf = dataSelf;

  // ---------- 4) does the SELF path hit the same gate? -----------------------
  res.paths = {};
  for (const [pname, data] of [['placeBinaryOrderFor (delegated)', dataFor],
                               ['placeBinaryOrder (self)', dataSelf]]) {
    const j = await call(rpc, 'eth_call', [{ from: OPERATOR, to: pool, data }, 'latest']);
    let raw = null;
    if (j.error) for (const c of [j.error.data, j.error.data?.data, j.error.message]) {
      if (typeof c === 'string') { const m = c.match(/0x[0-9a-fA-F]{8,}/); if (m) { raw = m[0]; break; }
        if (/^0x$/.test(c.trim())) { raw = '0x'; break; } }
    }
    const sel = raw && raw !== '0x' ? raw.slice(0, 10) : raw;
    res.paths[pname] = { selector: dataFor === data ? '0x5d97c566' : data.slice(0, 10),
      revertSelector: sel, revertName: sel ? (ERRMAP[sel] ?? 'UNKNOWN') : 'no revert data', revertRaw: raw };
    console.log(`  ${pname.padEnd(32)} -> ${sel} = ${res.paths[pname].revertName}`);
  }

  // ---------- 1) callTracer: any external call before the revert? ------------
  const ct = await call(rpc, 'debug_traceCall', [
    { from: OPERATOR, to: pool, data: dataFor, gas: '0x2000000' }, 'latest',
    { tracer: 'callTracer', tracerConfig: { withLog: true } }]);
  const flat = [];
  (function walk(n, d) {
    if (!n) return;
    flat.push({ depth: d, type: n.type, to: (n.to || '').toLowerCase(),
      name: names[(n.to || '').toLowerCase()] ?? '(unrecognised)',
      input4: (n.input || '').slice(0, 10), error: n.error, output: n.output });
    (n.calls || []).forEach(c => walk(c, d + 1));
  })(ct.result, 0);
  res.callTree = flat;
  res.callTracerError = ct.error ? JSON.stringify(ct.error).slice(0, 200) : undefined;
  console.log('\n  --- call tree ---');
  flat.forEach(f => console.log(`   d${f.depth} ${f.type.padEnd(12)} ${f.to} ${f.name}` +
    ` sel=${f.input4}${f.error ? ' ERR=' + f.error : ''}${f.output && f.output !== '0x' ? ' out=' + f.output.slice(0, 10) : ''}`));
  const externals = flat.filter(f => f.depth > 0);
  res.touchedRegistryViaCall = externals.some(f => f.to === REG.toLowerCase());
  console.log(`  external calls: ${externals.length}; any to OperatorPermissionsRegistry (${REG}): ${res.touchedRegistryViaCall}`);

  // ---------- 2) prestateTracer (NON-diff): all accounts + slots READ --------
  const ps = await call(rpc, 'debug_traceCall', [
    { from: OPERATOR, to: pool, data: dataFor, gas: '0x2000000' }, 'latest',
    { tracer: 'prestateTracer', tracerConfig: { diffMode: false } }]);
  const accts = ps.result || {};
  res.accessed = Object.entries(accts).map(([addr, v]) => ({
    addr, name: names[addr.toLowerCase()] ?? '(unrecognised)',
    codeLen: v.code ? (v.code.length - 2) / 2 : 0,
    slotsRead: Object.keys(v.storage || {}).length,
    storage: v.storage || {},
  }));
  res.prestateError = ps.error ? JSON.stringify(ps.error).slice(0, 200) : undefined;
  console.log('\n  --- accounts touched (prestateTracer, non-diff) ---');
  res.accessed.forEach(a => {
    console.log(`   ${a.addr} ${a.name} codeLen=${a.codeLen} slotsRead=${a.slotsRead}`);
    Object.entries(a.storage).forEach(([k, v]) => console.log(`       ${k} = ${v}`));
  });
  res.registryAccessed = res.accessed.some(a => a.addr.toLowerCase() === REG.toLowerCase());
  console.log(`  registry ${REG} appears in touched set: ${res.registryAccessed}`);

  // ---------- 3) structLogger: last SLOADs before REVERT ---------------------
  const sl = await call(rpc, 'debug_traceCall', [
    { from: OPERATOR, to: pool, data: dataFor, gas: '0x2000000' }, 'latest',
    { disableMemory: true, disableStorage: false, disableStack: false }]);
  if (sl.result?.structLogs) {
    const logs = sl.result.structLogs;
    const interesting = logs.filter(l => ['SLOAD', 'REVERT', 'STATICCALL', 'DELEGATECALL', 'CALL'].includes(l.op));
    res.opSummary = interesting.slice(-25).map(l => ({
      pc: l.pc, op: l.op, depth: l.depth,
      top: l.stack ? l.stack.slice(-3) : undefined,
    }));
    res.totalSloads = logs.filter(l => l.op === 'SLOAD').length;
    console.log(`\n  --- structLogger: ${logs.length} steps, ${res.totalSloads} SLOADs; last ops before revert ---`);
    res.opSummary.forEach(o => console.log(`   pc=${String(o.pc).padEnd(6)} d${o.depth} ${o.op.padEnd(13)} stackTop=${(o.top || []).slice().reverse().join(' , ')}`));
  } else {
    res.structLogError = sl.error ? JSON.stringify(sl.error).slice(0, 300) : 'no structLogs';
    console.log('\n  structLogger unavailable:', res.structLogError);
  }
  return res;
}

const out = {};
try {
  const tex = new SomniaMarkets(TESTNET_CFG);
  const live = await tex.client.listLiveBinaryMarkets();
  const m = live.find(x => x.status === 'Trading') ?? live[0];
  out.testnet = await analyse('TESTNET (Shannon 50312)', TESTNET_CFG, TESTNET_RPC, 'testnet',
    m.poolAddress, m.quoteDecimals, m);
} catch (e) { out.testnetError = String(e.message); console.log('testnet failed:', e.message); }
try {
  out.mainnetETH = await analyse('MAINNET (5031) ETH pool', MAINNET_CFG, MAINNET_RPC, 'mainnet',
    MAINNET_POOLS.ETH, 18, null);
} catch (e) { out.mainnetError = String(e.message); console.log('mainnet failed:', e.message); }

fs.writeFileSync('STEP2C-RESULT.json', JSON.stringify(out, null, 2));
console.log('\n-> wrote STEP2C-RESULT.json');
process.exit(0);
