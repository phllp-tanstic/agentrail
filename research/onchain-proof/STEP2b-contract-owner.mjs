// STEP 2b: does placeBinaryOrderFor accept a CONTRACT as `owner`, or is a contract
// owner rejected earlier than an EOA owner is?
//
// Method: identical revert-triangulation to step4_encode_order.mjs. Hold every
// argument constant except `owner`, vary owner across {EOA, real deployed
// contract, Safe-with-code-override}, and compare WHICH revert comes back against
// a bogus-selector control (empty 0x = not dispatched) and against the EOA
// baseline. Same revert as the EOA => no contract-specific gate. Different revert
// => the gate exists and this names it.
//
// READ-ONLY: eth_call only. Nothing signed, nothing broadcast.
import { encodeFunctionData, parseUnits } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { SomniaMarkets, binaryPoolWriteAbi, ORDER_TYPE, SELF_MATCHING_OPTION,
         ZERO_ADDRESS } from '@somnia-chain/markets-sdk';
import { TESTNET_CFG, MAINNET_CFG, TESTNET_RPC, MAINNET_RPC, MAINNET_POOLS,
         ethCall, extractRevertData, OPERATOR_KEY } from './config.mjs';
import { snapPriceToTick, isOnTick } from './tickmath.mjs';
import fs from 'node:fs';

const ERRMAP = JSON.parse(fs.readFileSync('error-selectors.json', 'utf8'));
function decodeRevert(d) {
  if (d === null) return 'NO REVERT DATA';
  if (d === '0x') return 'EMPTY 0x  <-- not dispatched';
  const s = d.slice(0, 10).toLowerCase();
  const named = ERRMAP[s];
  let out = `${s} = ${named ?? 'UNKNOWN (absent from contractErrorsAbi)'}`;
  if (named && d.length > 10) {
    const types = named.slice(named.indexOf('(') + 1, -1).split(',').filter(Boolean);
    const words = d.slice(10).match(/.{64}/g) || [];
    out += `  ( ${words.map((w, i) => (types[i] === 'address'
      ? `address=0x${w.slice(24)}` : `${types[i] ?? '?'}=${BigInt('0x' + w)}`)).join(', ')} )`;
  }
  return out;
}

const OPERATOR = privateKeyToAccount(OPERATOR_KEY || generatePrivateKey()).address;
const EOA_OWNER = privateKeyToAccount('0x' + '11'.repeat(32)).address; // baseline EOA

// Real deployed contracts on Somnia to use as a contract `owner`.
const CONTRACT_OWNERS = {
  'MultiSend 1.4.1':        '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
  'Safe singleton 1.3.0':   '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552',
  'SafeProxyFactory 1.3.0': '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
};
// The exact synthetic Safe address used in STEP 2, given real code via override.
const STEP2_SAFE = '0xdddd000000000000000000000000000000000004';

function encodeOrderFor({ owner, kind, priceRaw, qtyRaw, expireNs, orderType, smo }) {
  return encodeFunctionData({
    abi: binaryPoolWriteAbi, functionName: 'placeBinaryOrderFor',
    args: [owner, kind, priceRaw, qtyRaw, expireNs, orderType, smo, ZERO_ADDRESS, 0n, 0n],
  });
}

async function probe(label, cfg, rpc, poolAddr, decimals, marketInfo) {
  console.log('\n' + '='.repeat(76));
  console.log(`### ${label}`);
  console.log(`    pool=${poolAddr} decimals=${decimals}`);
  const res = { label, pool: poolAddr, decimals, operatorFrom: OPERATOR, owners: {} };

  const ex = new SomniaMarkets(cfg);
  const bp = await ex.client.getBinaryBookParams(poolAddr);
  const tick = BigInt(bp.tickSize), minQ = BigInt(bp.minQuantity);
  const priceOn = snapPriceToTick(0.62, tick, decimals);
  const qty = minQ * 10n;
  const expireNs = marketInfo
    ? BigInt(marketInfo.expiry) * 1_000_000_000n
    : BigInt(Math.floor(Date.now() / 1000) + 300) * 1_000_000_000n;
  res.tickSize = tick.toString();
  res.priceOn = priceOn.toString();
  res.onTick = isOnTick(priceOn, tick);
  res.qty = qty.toString();
  res.expireNs = expireNs.toString();
  console.log(`    tickSize=${tick} priceOn=${priceOn} (onTick=${res.onTick}) qty=${qty}`);

  const base = { kind: 0, priceRaw: priceOn, qtyRaw: qty, expireNs,
                 orderType: ORDER_TYPE.LIMIT, smo: SELF_MATCHING_OPTION.CANCEL_TAKER };

  // -------- CONTROL: bogus selector, identical arg tail -> must be EMPTY 0x -----
  const eoaData = encodeOrderFor({ ...base, owner: EOA_OWNER });
  const bogus = '0xdeadbe01' + eoaData.slice(10);
  const rc = await ethCall(rpc, { from: OPERATOR, to: poolAddr, data: bogus });
  res.control = decodeRevert(extractRevertData(rc));
  console.log(`\n  [CONTROL bogus selector] -> ${res.control}`);

  // -------- baseline: EOA owner -------------------------------------------------
  {
    const r = await ethCall(rpc, { from: OPERATOR, to: poolAddr, data: eoaData });
    const d = extractRevertData(r);
    res.owners['EOA baseline'] = { owner: EOA_OWNER, isContract: false,
      calldata: eoaData, revertRaw: d, revert: r.error ? decodeRevert(d) : `NO REVERT ${r.result}` };
    console.log(`  [EOA owner ${EOA_OWNER}]`);
    console.log(`    selector ${eoaData.slice(0, 10)} bytes ${(eoaData.length - 2) / 2} -> ${res.owners['EOA baseline'].revert}`);
  }

  // -------- real deployed contracts as owner ------------------------------------
  for (const [name, addr] of Object.entries(CONTRACT_OWNERS)) {
    const code = await ethCall(rpc, { to: addr, data: '0x' }); // presence probe below
    const codeRes = await fetch(rpc, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [addr, 'latest'] }) });
    const codeLen = (((await codeRes.json()).result || '0x').length - 2) / 2;
    const data = encodeOrderFor({ ...base, owner: addr });
    const r = await ethCall(rpc, { from: OPERATOR, to: poolAddr, data });
    const d = extractRevertData(r);
    res.owners[name] = { owner: addr, isContract: codeLen > 0, codeLen,
      revertRaw: d, revert: r.error ? decodeRevert(d) : `NO REVERT ${r.result}` };
    console.log(`  [contract owner ${name} ${addr} codeLen=${codeLen}]`);
    console.log(`    -> ${res.owners[name].revert}`);
  }

  // -------- the STEP 2 Safe address, with real Safe code injected ---------------
  {
    const cr = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode',
        params: [CONTRACT_OWNERS['Safe singleton 1.3.0'], 'latest'] }) });
    const safeCode = (await cr.json()).result;
    const data = encodeOrderFor({ ...base, owner: STEP2_SAFE });
    const body = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [
      { from: OPERATOR, to: poolAddr, data }, 'latest',
      { [STEP2_SAFE]: { code: safeCode } }] };
    const rr = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    const j = await rr.json();
    const d = extractRevertData(j);
    res.owners['STEP2 Safe (code-override)'] = { owner: STEP2_SAFE,
      injectedCodeLen: ((safeCode || '0x').length - 2) / 2, revertRaw: d,
      revert: j.error ? decodeRevert(d) : `NO REVERT ${j.result}` };
    console.log(`  [STEP2 Safe ${STEP2_SAFE} with Safe 1.3.0 code injected]`);
    console.log(`    -> ${res.owners['STEP2 Safe (code-override)'].revert}`);
  }

  // -------- verdict -------------------------------------------------------------
  const baseRv = res.owners['EOA baseline'].revertRaw;
  res.comparison = Object.entries(res.owners).map(([k, v]) => ({
    owner: k, sameAsEoa: v.revertRaw === baseRv, revertRaw: v.revertRaw }));
  const differs = res.comparison.filter(c => !c.sameAsEoa);
  res.verdict = differs.length === 0
    ? 'IDENTICAL: every contract owner produces the exact same revert as the EOA owner -> no contract-specific gate'
    : `DIVERGENT: ${differs.map(d => d.owner).join(', ')} differ from the EOA baseline`;
  console.log(`\n  VERDICT: ${res.verdict}`);
  return res;
}

const out = {};
try {
  const tex = new SomniaMarkets(TESTNET_CFG);
  const live = await tex.client.listLiveBinaryMarkets();
  const m = live.find(x => x.status === 'Trading') ?? live[0];
  out.testnet = await probe('TESTNET (Shannon 50312, 6 dec)', TESTNET_CFG, TESTNET_RPC,
                            m.poolAddress, m.quoteDecimals, m);
} catch (e) { out.testnetError = String(e.message); console.log('testnet probe failed:', e.message); }
try {
  out.mainnetETH = await probe('MAINNET (5031, 18 dec) ETH pool', MAINNET_CFG, MAINNET_RPC,
                               MAINNET_POOLS.ETH, 18, null);
} catch (e) { out.mainnetError = String(e.message); console.log('mainnet probe failed:', e.message); }

fs.writeFileSync('STEP2B-RESULT.json', JSON.stringify(out, null, 2));
console.log('\n-> wrote STEP2B-RESULT.json');
process.exit(0);
