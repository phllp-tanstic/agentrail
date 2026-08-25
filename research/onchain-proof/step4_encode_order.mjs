// STEP 4: hand-encode placeBinaryOrderFor against the raw tradeAbi (the SDK's binary
// PlaceOrderParams has NO `owner` field, so the SDK cannot express this call), snap the
// price to the pool's REAL tick size, and prove the calldata is byte-correct and
// dispatched by simulating with eth_call from a synthetic operator `from` address.
//
// The proof logic:
//   * A CONTROL probe with a deliberately bogus selector must revert with EMPTY 0x
//     (no such function -> fallback/absent). That is what "wrong encoding" looks like.
//   * The real placeBinaryOrderFor calldata must instead revert with a DECODABLE
//     custom error from contractErrorsAbi - specifically OnlyApprovedContracts()
//     (0x3fb0ba2e), the operator-authorization gate. Reaching that gate proves the
//     selector resolved, the 10 args decoded, and execution got into the function body.
//
// Signing/submitting is BLOCKED without AGENTRAIL_OWNER_KEY.
import { encodeFunctionData, parseUnits } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { SomniaMarkets, binaryPoolWriteAbi, ORDER_TYPE, SELF_MATCHING_OPTION,
         ORDER_KIND_SIDE, ZERO_ADDRESS } from '@somnia-chain/markets-sdk';
import { TESTNET_CFG, MAINNET_CFG, TESTNET_RPC, MAINNET_RPC, MAINNET_POOLS,
         ethCall, extractRevertData, HAVE_KEY, OPERATOR_KEY } from './config.mjs';
import { snapPriceToTick, isOnTick, rawToProbString } from './tickmath.mjs';
import fs from 'node:fs';

const ERRMAP = JSON.parse(fs.readFileSync('error-selectors.json', 'utf8'));
function decodeRevert(d) {
  if (d === null) return 'NO REVERT DATA';
  if (d === '0x') return 'EMPTY 0x  <-- no selector: function absent / not dispatched';
  const s = d.slice(0, 10).toLowerCase();
  const named = ERRMAP[s];
  let out = `${s} = ${named ?? 'UNKNOWN (absent from contractErrorsAbi)'}`;
  // decode the args so the revert is self-documenting
  if (named && d.length > 10) {
    const types = named.slice(named.indexOf('(') + 1, -1).split(',').filter(Boolean);
    const words = d.slice(10).match(/.{64}/g) || [];
    const vals = words.map((w, i) => {
      const t = types[i] ?? '?';
      if (t === 'address') return `${t}=0x${w.slice(24)}`;
      return `${t}=${BigInt('0x' + w)}`;
    });
    out += `  ( ${vals.join(', ')} )`;
  }
  return out;
}

const opAcct = privateKeyToAccount(OPERATOR_KEY || generatePrivateKey());
const OPERATOR = opAcct.address;
const OWNER = privateKeyToAccount('0x' + '11'.repeat(32)).address; // synthetic owner
console.log('synthetic operator (eth_call `from`):', OPERATOR);
console.log('synthetic owner   (order `owner`)   :', OWNER);

/** Build placeBinaryOrderFor calldata from the RAW ABI. */
function encodeOrderFor({ owner, kind, priceRaw, qtyRaw, expireNs, orderType, smo }) {
  return encodeFunctionData({
    abi: binaryPoolWriteAbi, functionName: 'placeBinaryOrderFor',
    args: [owner, kind, priceRaw, qtyRaw, expireNs, orderType, smo,
           ZERO_ADDRESS,  // builder: capped at 0 on every live venue -> pass zero
           0n,            // builderFeeBpsTimes1k: MUST be 0
           0n],           // userData
  });
}
function encodeOrderSelf({ kind, priceRaw, qtyRaw, expireNs, orderType, smo }) {
  return encodeFunctionData({
    abi: binaryPoolWriteAbi, functionName: 'placeBinaryOrder',
    args: [kind, priceRaw, qtyRaw, expireNs, orderType, smo, ZERO_ADDRESS, 0n, 0n],
  });
}

async function probeChain(label, cfg, rpc, poolAddr, decimals, marketInfo) {
  console.log('\n' + '='.repeat(78));
  console.log(`### ${label}  pool=${poolAddr}  decimals=${decimals}`);
  if (marketInfo) console.log(`    market=${marketInfo.marketId} asset=${marketInfo.asset} expiry=${marketInfo.expiry}`);
  const ex = new SomniaMarkets(cfg);
  const bp = await ex.client.getBinaryBookParams(poolAddr);
  const tick = BigInt(bp.tickSize), lot = BigInt(bp.lotSize), minQ = BigInt(bp.minQuantity);
  console.log(`    tickSize=${tick} lotSize=${lot} minQuantity=${minQ}`);

  const PROB = 0.62;                                        // an ordinary probability
  const priceOn = snapPriceToTick(PROB, tick, decimals);     // CORRECT
  const priceNaive = parseUnits(PROB.toFixed(18), decimals); // THE BROKEN PATH
  console.log(`    prob ${PROB}: snapped=${priceOn} (onTick=${isOnTick(priceOn, tick)}) | naive=${priceNaive} (onTick=${isOnTick(priceNaive, tick)})`);

  const qty = minQ * 10n;
  // Expiry must NOT exceed the market's own expiry, else OrderExpiryBeyondMarket().
  // Testnet markets here are 1-minute, so a naive now+300s is rejected.
  const expireNs = marketInfo
    ? BigInt(marketInfo.expiry) * 1_000_000_000n
    : BigInt(Math.floor(Date.now() / 1000) + 300) * 1_000_000_000n;
  console.log(`    expireTimestampNs=${expireNs}${marketInfo ? ' (pinned to market expiry)' : ''}`);
  const base = { owner: OWNER, kind: 0 /* BUY_YES */, qtyRaw: qty, expireNs,
                 orderType: ORDER_TYPE.LIMIT, smo: SELF_MATCHING_OPTION.CANCEL_TAKER };

  // ---- CONTROL: bogus selector, same tail. This is what BAD ENCODING looks like.
  const good = encodeOrderFor({ ...base, priceRaw: priceOn });
  const bogus = '0xdeadbe01' + good.slice(10);
  console.log('\n  [CONTROL] bogus selector 0xdeadbe01 + identical args tail');
  console.log('    ->', decodeRevert(extractRevertData(await ethCall(rpc, { from: OPERATOR, to: poolAddr, data: bogus }))));

  // ---- A: placeBinaryOrderFor, ON-TICK price
  console.log('\n  [A] placeBinaryOrderFor  ON-TICK price', priceOn, `(= ${rawToProbString(priceOn, decimals)})`);
  console.log('    selector', good.slice(0, 10), '| calldata bytes', (good.length - 2) / 2,
              '(expect 4 + 10*32 = 324)');
  const rA = await ethCall(rpc, { from: OPERATOR, to: poolAddr, data: good });
  const dA = extractRevertData(rA);
  console.log('    ->', rA.error ? decodeRevert(dA) : `NO REVERT, returned ${rA.result}`);

  // ---- B: placeBinaryOrderFor, OFF-TICK naive price
  const bad = encodeOrderFor({ ...base, priceRaw: priceNaive });
  console.log('\n  [B] placeBinaryOrderFor  OFF-TICK naive price', priceNaive);
  const rB = await ethCall(rpc, { from: OPERATOR, to: poolAddr, data: bad });
  const dB = extractRevertData(rB);
  console.log('    ->', rB.error ? decodeRevert(dB) : `NO REVERT, returned ${rB.result}`);

  // ---- C/D: placeBinaryOrder (SELF, no operator auth needed) on-tick vs off-tick.
  // This can isolate the tick check from the authorization check.
  const selfOn = encodeOrderSelf({ ...base, priceRaw: priceOn });
  const selfOff = encodeOrderSelf({ ...base, priceRaw: priceNaive });
  console.log('\n  [C] placeBinaryOrder (self) ON-TICK   selector', selfOn.slice(0, 10));
  const rC = await ethCall(rpc, { from: OPERATOR, to: poolAddr, data: selfOn });
  const dC = extractRevertData(rC);
  console.log('    ->', rC.error ? decodeRevert(dC) : `NO REVERT, returned ${rC.result}`);
  console.log('  [D] placeBinaryOrder (self) OFF-TICK');
  const rD = await ethCall(rpc, { from: OPERATOR, to: poolAddr, data: selfOff });
  const dD = extractRevertData(rD);
  console.log('    ->', rD.error ? decodeRevert(dD) : `NO REVERT, returned ${rD.result}`);

  if (dC && dD && dC !== dD) {
    console.log('\n  *** ON-TICK and OFF-TICK produce DIFFERENT reverts on the self path.');
    console.log('      => the tick-alignment check is observable ON-CHAIN, no key needed.');
  }

  // ---- builder fee cap, read-only
  try {
    const cap = await ethCall(rpc, { to: poolAddr,
      data: encodeFunctionData({ abi: binaryPoolWriteAbi, functionName: 'getMaxBuilderFeeBpsTimes1k', args: [] }) });
    console.log('\n  getMaxBuilderFeeBpsTimes1k ->', cap.result,
                cap.result ? `= ${BigInt(cap.result)}` : `(err ${decodeRevert(extractRevertData(cap))})`);
  } catch (e) { console.log('  builder cap read err', e.message); }

  return { pool: poolAddr, tick: tick.toString(), priceOn: priceOn.toString(),
           priceNaive: priceNaive.toString(), calldataOnTick: good, calldataOffTick: bad,
           revert: { control: decodeRevert(extractRevertData(await ethCall(rpc, { from: OPERATOR, to: poolAddr, data: bogus }))),
                     A_forOnTick: rA.error ? decodeRevert(dA) : 'no revert',
                     B_forOffTick: rB.error ? decodeRevert(dB) : 'no revert',
                     C_selfOnTick: rC.error ? decodeRevert(dC) : 'no revert',
                     D_selfOffTick: rD.error ? decodeRevert(dD) : 'no revert' } };
}

// ---------------------------------------------------------------- run the probes
const results = {};
const tex = new SomniaMarkets(TESTNET_CFG);
const live = await tex.client.listLiveBinaryMarkets();
const m = live.find(x => x.status === 'Trading') ?? live[0];
results.testnet = await probeChain('TESTNET (Shannon 50312, 6 dec)', TESTNET_CFG, TESTNET_RPC,
                                   m.poolAddress, m.quoteDecimals, m);
results.mainnetETH = await probeChain('MAINNET (5031, 18 dec) ETH pool', MAINNET_CFG, MAINNET_RPC,
                                      MAINNET_POOLS.ETH, 18, null);

// ------------------------------------------------------------- the signed submit
console.log('\n' + '='.repeat(78));
console.log('=== SIGNED SUBMIT + BALANCE-DELTA CHECK ===');
if (!HAVE_KEY) {
  console.log('BLOCKED: no AGENTRAIL_OWNER_KEY. Cannot sign, cannot submit, cannot observe a fill,');
  console.log('and cannot verify that collateral left the OWNER wallet rather than the operator wallet.');
  console.log('TX HASH: none - BLOCKED. No hash is reported because none was ever produced.');
  console.log('\nThe exact tx that would be broadcast by the OPERATOR key (testnet):');
  console.log(JSON.stringify({ chainId: 50312, from: OPERATOR, to: results.testnet.pool,
                               data: results.testnet.calldataOnTick, value: '0x0' }, null, 2));
} else {
  console.log('see step4_submit.mjs - run that with the key set');
}

fs.writeFileSync('step4-probes.json', JSON.stringify(results, null, 2));
console.log('\n-> wrote step4-probes.json');
process.exit(0);
