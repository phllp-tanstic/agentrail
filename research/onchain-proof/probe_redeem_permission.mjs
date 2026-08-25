// PROBE: why does the module-routed redeem return InsufficientPermission() rather than
// InsufficientBalance()? Hypothesis: BinaryMarketsModule burns the owner's ERC-6909
// outcome tokens, so it needs an ERC-6909 operator approval from the owner
// (OutcomeToken6909.setOperator(module,true)) BEFORE any module-routed redeem can work.
// If true, that is an EXTRA prerequisite step in the lifecycle that the brief's
// ground truth does not mention. READ-ONLY.
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SOMNIA_TESTNET_ADDRESSES, SomniaMarkets, binarySettlementAbi } from '@somnia-chain/markets-sdk';
import { TESTNET_RPC, TESTNET_CFG, ethCall, extractRevertData, CORE } from './config.mjs';
import fs from 'node:fs';

const ERRMAP = JSON.parse(fs.readFileSync('error-selectors.json', 'utf8'));
const dec = (d) => d === null ? 'NO DATA' : d === '0x' ? 'EMPTY 0x'
  : `${d.slice(0,10)} = ${ERRMAP[d.slice(0,10).toLowerCase()] ?? 'UNKNOWN'}`;

const MODULE = SOMNIA_TESTNET_ADDRESSES.binaryModule;
const TOKEN = CORE.outcomeToken6909;
const owner = privateKeyToAccount('0x' + '11'.repeat(32)).address;

// minimal ERC-6909 surface
const abi6909 = [
  { type:'function', name:'isOperator', stateMutability:'view',
    inputs:[{type:'address'},{type:'address'}], outputs:[{type:'bool'}] },
  { type:'function', name:'setOperator', stateMutability:'nonpayable',
    inputs:[{name:'spender',type:'address'},{name:'approved',type:'bool'}], outputs:[{type:'bool'}] },
  { type:'function', name:'balanceOf', stateMutability:'view',
    inputs:[{type:'address'},{type:'uint256'}], outputs:[{type:'uint256'}] },
];

console.log('OutcomeToken6909 =', TOKEN);
console.log('BinaryMarketsModule =', MODULE);
console.log('synthetic owner =', owner);

// 1. is the module already an ERC-6909 operator for this owner?
for (const [label, a, b] of [['owner -> module', owner, MODULE],
                             ['owner -> settlement', owner, CORE.binarySettlement]]) {
  const data = encodeFunctionData({ abi: abi6909, functionName: 'isOperator', args: [a, b] });
  const j = await ethCall(TESTNET_RPC, { to: TOKEN, data });
  if (j.error) console.log(`isOperator(${label}) REVERT ->`, dec(extractRevertData(j)));
  else console.log(`isOperator(${label}) =`,
    decodeFunctionResult({ abi: abi6909, functionName: 'isOperator', data: j.result }),
    `(raw ${j.result})`);
}

// 2. confirm the owner's outcome balance really is zero (so "permission" is not masking "balance")
const ex = new SomniaMarkets(TESTNET_CFG);
const fin = await ex.client.listBinaryMarkets({ status: 'Finalized', limit: 5 });
const t = fin[0];
console.log('\nfinalized market', t.marketId, 'yesTokenId', t.yesTokenId);
{
  const data = encodeFunctionData({ abi: abi6909, functionName: 'balanceOf', args: [owner, BigInt(t.yesTokenId)] });
  const j = await ethCall(TESTNET_RPC, { to: TOKEN, data });
  console.log('balanceOf(owner, yesId) =', j.error ? dec(extractRevertData(j))
    : decodeFunctionResult({ abi: abi6909, functionName: 'balanceOf', data: j.result }));
}

// 3. simulate setOperator(module,true) from the owner - does the token accept it?
{
  const data = encodeFunctionData({ abi: abi6909, functionName: 'setOperator', args: [MODULE, true] });
  const j = await ethCall(TESTNET_RPC, { from: owner, to: TOKEN, data });
  console.log('\nsetOperator(module,true) eth_call from owner ->',
    j.error ? `REVERT ${dec(extractRevertData(j))}` : `OK returned ${j.result}`);
  console.log('  calldata:', data);
  console.log('  => if this succeeds, the grant is a plain self-scoped call needing only gas.');
}

// 4. decisive test: does the direct BinarySettlement path (no module) complain about
//    BALANCE while the module path complains about PERMISSION? If the owner had a
//    balance we could not separate these, but with zero balance the module path
//    failing EARLIER (on permission) proves the permission gate precedes the burn.
{
  const direct = encodeFunctionData({ abi: binarySettlementAbi, functionName: 'redeem',
    args: [BigInt(t.yesTokenId), 1000n, owner] });
  const j = await ethCall(TESTNET_RPC, { from: owner, to: CORE.binarySettlement, data: direct });
  console.log('\nBinarySettlement.redeem (direct, owner is caller) ->',
    j.error ? dec(extractRevertData(j)) : `OK ${j.result}`);
  console.log('  vs module-routed redeem/redeemFor which returned InsufficientPermission()');
  console.log('  => the two paths fail at DIFFERENT gates, so the module path has an extra');
  console.log('     authorization requirement beyond simply holding the tokens.');
}
process.exit(0);
