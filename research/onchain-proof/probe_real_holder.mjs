// DECISIVE TEST: find a REAL address that actually holds outcome tokens in a
// FINALIZED testnet market, then eth_call the module-routed self redeem AS that
// address. No signature and no key are needed for the self path (`redeem`), so this
// works read-only. If a genuine holder with a non-zero balance still hits
// InsufficientPermission() while isOperator(holder -> module) is false, the
// ERC-6909 operator prerequisite is proven rather than merely inferred.
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { SomniaMarkets, binaryModuleWriteAbi, binarySettlementAbi,
         SOMNIA_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk';
import { TESTNET_CFG, TESTNET_RPC, ethCall, extractRevertData, CORE } from './config.mjs';
import fs from 'node:fs';

const ERRMAP = JSON.parse(fs.readFileSync('error-selectors.json', 'utf8'));
const dec = (d) => d === null ? 'NO DATA' : d === '0x' ? 'EMPTY 0x'
  : `${d.slice(0,10)} = ${ERRMAP[d.slice(0,10).toLowerCase()] ?? 'UNKNOWN'}`;
const MODULE = SOMNIA_TESTNET_ADDRESSES.binaryModule;
const TOKEN = CORE.outcomeToken6909;
const abi6909 = [
  { type:'function', name:'isOperator', stateMutability:'view', inputs:[{type:'address'},{type:'address'}], outputs:[{type:'bool'}] },
  { type:'function', name:'balanceOf', stateMutability:'view', inputs:[{type:'address'},{type:'uint256'}], outputs:[{type:'uint256'}] },
];
const ex = new SomniaMarkets(TESTNET_CFG);

// ---- find finalized markets that actually traded, then pull their fills for addresses
const fin = await ex.client.listBinaryMarkets({ status: 'Finalized', limit: 60 });
const traded = fin.filter(m => BigInt(m.tradeCount ?? 0) > 0n);
console.log(`finalized markets: ${fin.length}, of which traded: ${traded.length}`);

const candidates = new Map(); // address -> {market, tokenId, bal}
for (const m of traded.slice(0, 12)) {
  let fills = [];
  try { fills = await ex.client.getFills({ marketId: m.marketId, limit: 40 }); }
  catch (e) { try { fills = await ex.client.getFills(m.marketId); } catch { continue; } }
  const addrs = new Set();
  for (const f of fills) for (const k of ['maker','taker','trader','owner','buyer','seller','account'])
    if (typeof f?.[k] === 'string' && f[k].startsWith('0x') && f[k].length === 42) addrs.add(f[k]);
  for (const a of addrs) {
    for (const [side, id] of [['YES', m.yesTokenId], ['NO', m.noTokenId]]) {
      const j = await ethCall(TESTNET_RPC, { to: TOKEN,
        data: encodeFunctionData({ abi: abi6909, functionName:'balanceOf', args:[a, BigInt(id)] }) });
      if (j.error || !j.result) continue;
      const bal = BigInt(j.result);
      if (bal > 0n) { candidates.set(`${a}|${m.marketId}|${side}`, { addr:a, market:m, side, id, bal }); }
    }
  }
  if (candidates.size >= 3) break;
}
console.log('holders with a NON-ZERO balance in a finalized market:', candidates.size);
if (candidates.size === 0) {
  console.log('none found in the sampled window -> cannot upgrade the hypothesis this way.');
  process.exit(0);
}

for (const [k, c] of [...candidates].slice(0, 4)) {
  console.log('\n' + '-'.repeat(70));
  console.log(`holder ${c.addr}  market ${c.market.marketId}  ${c.side}  balance ${c.bal}`);
  console.log(`  winningOutcome=${c.market.winningOutcome} payoutNum=${JSON.stringify(c.market.payoutNumerators)}`);

  // is the module an ERC-6909 operator for this real holder?
  const io = await ethCall(TESTNET_RPC, { to: TOKEN,
    data: encodeFunctionData({ abi: abi6909, functionName:'isOperator', args:[c.addr, MODULE] }) });
  const isOp = io.error ? 'ERR' : decodeFunctionResult({ abi: abi6909, functionName:'isOperator', data: io.result });
  console.log(`  isOperator(holder -> module) = ${isOp}`);

  const outcomeIdx = c.side === 'YES' ? 0 : 1;
  // module-routed SELF redeem (no signature needed) simulated AS the holder
  const modData = encodeFunctionData({ abi: binaryModuleWriteAbi, functionName:'redeem',
    args:[c.market.operatorId ?? 0, c.market.venueId ?? ('0x'+'00'.repeat(32)), c.market.marketId, outcomeIdx, c.bal] });
  const rm = await ethCall(TESTNET_RPC, { from: c.addr, to: MODULE, data: modData });
  console.log(`  module redeem  -> ${rm.error ? dec(extractRevertData(rm)) : 'NO REVERT (would succeed!) ' + rm.result}`);

  // direct settlement redeem simulated AS the holder
  const dirData = encodeFunctionData({ abi: binarySettlementAbi, functionName:'redeem',
    args:[BigInt(c.id), c.bal, c.addr] });
  const rd = await ethCall(TESTNET_RPC, { from: c.addr, to: CORE.binarySettlement, data: dirData });
  console.log(`  direct redeem  -> ${rd.error ? dec(extractRevertData(rd)) : 'NO REVERT (would succeed!) ' + rd.result}`);

  // ALSO: redeeming a LOSING outcome must NOT revert - it should pay zero.
  const loseIdx = Number(c.market.winningOutcome) === 0 ? 1 : 0;
  const loseId = loseIdx === 0 ? c.market.yesTokenId : c.market.noTokenId;
  const lb = await ethCall(TESTNET_RPC, { to: TOKEN,
    data: encodeFunctionData({ abi: abi6909, functionName:'balanceOf', args:[c.addr, BigInt(loseId)] }) });
  const loseBal = lb.error ? 0n : BigInt(lb.result);
  if (loseBal > 0n) {
    const ld = encodeFunctionData({ abi: binarySettlementAbi, functionName:'redeem', args:[BigInt(loseId), loseBal, c.addr] });
    const rl = await ethCall(TESTNET_RPC, { from: c.addr, to: CORE.binarySettlement, data: ld });
    console.log(`  LOSING side balance ${loseBal} direct redeem -> ${rl.error ? dec(extractRevertData(rl)) : 'NO REVERT ' + rl.result}`);
    console.log('    (ground truth: redeeming a loss must NOT revert, it pays zero)');
  } else console.log('  (holder has no losing-side balance to test the pays-zero rule)');
}
process.exit(0);
