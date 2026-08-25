// STEP 2: (a) generate a fresh operator keypair - no funding needed
//         (b) prove setOperatorApprovalForPool calldata encodes correctly with bytes4[]
//         (c) prove the isApprovedForPool READ PATH works and returns a clean `false`
//             for a synthetic pair against a real BINARY pool address
//         (d) prove isGloballyApproved is also readable (and why it can never help)
// (a),(c),(d) need NO key. (b) encoding needs no key; SENDING it does -> BLOCKED.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, decodeFunctionResult, keccak256, toHex } from 'viem';
import { binaryPoolWriteAbi } from '@somnia-chain/markets-sdk';
import { SomniaMarkets } from '@somnia-chain/markets-sdk';
import { TESTNET_CFG, OPERATOR_REGISTRY, TESTNET_RPC, SEL, ethCall, extractRevertData,
         OPERATOR_KEY, HAVE_KEY } from './config.mjs';
import fs from 'node:fs';

const ERRMAP = JSON.parse(fs.readFileSync('error-selectors.json', 'utf8'));
const decodeRevert = (d) => {
  if (d === null) return 'no revert data';
  if (d === '0x') return 'EMPTY 0x (no selector -> function absent / bad dispatch)';
  const s = d.slice(0, 10).toLowerCase();
  return `${s} = ${ERRMAP[s] ?? 'UNKNOWN (not in contractErrorsAbi)'}${d.length > 10 ? ' [+args ' + d.slice(10) + ']' : ''}`;
};

// registry ABI - the CORRECTED signatures (selectors is bytes4[], not bytes4)
const registryAbi = [
  { type: 'function', name: 'setOperatorApprovalForPool', stateMutability: 'nonpayable',
    inputs: [{ name: 'pool', type: 'address' }, { name: 'operator', type: 'address' },
             { name: 'selectors', type: 'bytes4[]' }, { name: 'approved', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'isApprovedForPool', stateMutability: 'view',
    inputs: [{ name: 'pool', type: 'address' }, { name: 'owner', type: 'address' },
             { name: 'operator', type: 'address' }, { name: 'selector', type: 'bytes4' }],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isGloballyApproved', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' },
             { name: 'selector', type: 'bytes4' }], outputs: [{ type: 'bool' }] },
];

// ---------------------------------------------------------- (a) fresh operator
console.log('=== 2a. GENERATE FRESH OPERATOR KEYPAIR (no funding required) ===');
const opPk = OPERATOR_KEY || generatePrivateKey();
const operator = privateKeyToAccount(opPk);
console.log('operator address :', operator.address);
console.log('operator key src :', OPERATOR_KEY ? 'AGENTRAIL_OPERATOR_KEY env' : 'freshly generated (ephemeral)');
console.log('(key itself intentionally not printed)');

// A synthetic OWNER address we do NOT control - used only for read-path proofs.
// Derived from a fixed throwaway key so it is a valid checksummed EOA address.
const SYNTH_OWNER = privateKeyToAccount('0x' + '11'.repeat(32)).address;
console.log('synthetic owner  :', SYNTH_OWNER, '(read-path probe only, we do NOT hold this key)');

// ------------------------------------------------------ pick a live binary pool
const ex = new SomniaMarkets(TESTNET_CFG);
const live = await ex.client.listLiveBinaryMarkets();
const m = live.find(x => x.status === 'Trading') ?? live[0];
const POOL = m.poolAddress;
const REG = OPERATOR_REGISTRY.testnet;
console.log('\nlive binary pool :', POOL, `(market ${m.marketId}, ${m.asset}, expiry ${m.expiry})`);
console.log('registry (testnet):', REG);

// ---------------------------------------- (b) encode setOperatorApprovalForPool
console.log('\n=== 2b. ENCODE setOperatorApprovalForPool WITH bytes4[] ===');
const grantData = encodeFunctionData({
  abi: registryAbi, functionName: 'setOperatorApprovalForPool',
  args: [POOL, operator.address, [SEL.placeOrderFor], true],
});
console.log('calldata:', grantData);
const words = grantData.slice(10).match(/.{64}/g) || [];
console.log('selector         :', grantData.slice(0, 10),
            '(keccak of setOperatorApprovalForPool(address,address,bytes4[],bool) =',
            keccak256(toHex('setOperatorApprovalForPool(address,address,bytes4[],bool)')).slice(0, 10) + ')');
const labels = ['pool (addr)', 'operator (addr)', 'offset->selectors[]', 'approved (bool)',
                'selectors.length', 'selectors[0] (left-aligned bytes4)'];
words.forEach((w, i) => console.log(`  word[${i}] ${(labels[i] ?? '').padEnd(34)} 0x${w}`));
console.log('LAYOUT CHECK: word[2] offset =', BigInt('0x' + (words[2] ?? '0')),
            '(expect 128 = 4 static words * 32) ->',
            BigInt('0x' + (words[2] ?? '0')) === 128n ? 'CORRECT dynamic-array head' : 'UNEXPECTED');
console.log('LAYOUT CHECK: word[4] length =', BigInt('0x' + (words[4] ?? '0')), '(expect 1)');
console.log('LAYOUT CHECK: word[5] starts with', ('0x' + (words[5] ?? '')).slice(0, 10),
            '-> matches placeOrderFor', ('0x' + (words[5] ?? '')).slice(0, 10) === SEL.placeOrderFor);

// Prove the WRONG (single bytes4) encoding produces a DIFFERENT selector => would revert
const wrongAbi = [{ type: 'function', name: 'setOperatorApprovalForPool', stateMutability: 'nonpayable',
  inputs: [{ type: 'address' }, { type: 'address' }, { type: 'bytes4' }, { type: 'bool' }], outputs: [] }];
const wrongData = encodeFunctionData({ abi: wrongAbi, functionName: 'setOperatorApprovalForPool',
  args: [POOL, operator.address, SEL.placeOrderFor, true] });
console.log('\nWRONG single-bytes4 variant selector:', wrongData.slice(0, 10),
            '!= correct', grantData.slice(0, 10), '=>',
            wrongData.slice(0, 10) !== grantData.slice(0, 10)
              ? 'CONFIRMS the bytes4[] correction matters (different function entirely)' : 'same?!');

// eth_call-simulate the grant from the synthetic owner (no state written)
console.log('\n--- eth_call simulate the grant (from synthetic owner; nothing is written) ---');
const gsim = await ethCall(TESTNET_RPC, { from: SYNTH_OWNER, to: REG, data: grantData });
if (gsim.error) console.log('reverted ->', decodeRevert(extractRevertData(gsim)));
else console.log('eth_call returned', gsim.result,
  '-> NO REVERT: the registry accepts this calldata shape for a binary pool (self-scoped grant, msg.sender is the owner)');

// -------------------------------------------------- (c) isApprovedForPool read
console.log('\n=== 2c. READ PATH: isApprovedForPool (must return a clean false) ===');
for (const [label, owner, op] of [
  ['synthetic owner / fresh operator', SYNTH_OWNER, operator.address],
  ['operator as its own owner',        operator.address, operator.address],
]) {
  for (const [sname, s] of Object.entries(SEL)) {
    const data = encodeFunctionData({ abi: registryAbi, functionName: 'isApprovedForPool',
      args: [POOL, owner, op, s] });
    const j = await ethCall(TESTNET_RPC, { to: REG, data });
    if (j.error) { console.log(`  ${label} / ${sname}: REVERT ->`, decodeRevert(extractRevertData(j))); continue; }
    const v = decodeFunctionResult({ abi: registryAbi, functionName: 'isApprovedForPool', data: j.result });
    console.log(`  ${label} / ${sname.padEnd(14)} raw=${j.result} decoded=${v}`);
  }
}

console.log('\n=== 2d. isGloballyApproved (readable, but binary pools are unregistered) ===');
{
  const data = encodeFunctionData({ abi: registryAbi, functionName: 'isGloballyApproved',
    args: [SYNTH_OWNER, operator.address, SEL.placeOrderFor] });
  const j = await ethCall(TESTNET_RPC, { to: REG, data });
  if (j.error) console.log('  REVERT ->', decodeRevert(extractRevertData(j)));
  else console.log('  raw=', j.result, 'decoded=',
    decodeFunctionResult({ abi: registryAbi, functionName: 'isGloballyApproved', data: j.result }));
}

// -------------------------------------------------------------- the signed part
console.log('\n=== SIGNED GRANT (requires the OWNER key) ===');
if (!HAVE_KEY) {
  console.log('BLOCKED: AGENTRAIL_OWNER_KEY is not set, so the grant tx cannot be signed or sent.');
  console.log('To execute, run with the owner key set. The exact call that would be sent:');
  console.log(JSON.stringify({ chainId: 50312, to: REG, data: grantData, value: '0x0' }, null, 2));
  console.log('Then re-read isApprovedForPool(pool, owner, operator, 0x80054449) and require === true');
  console.log('BEFORE placing any order. Do NOT trust a non-reverting tx.');
} else {
  const { createWalletClient, createPublicClient, http } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const ownerAcct = privateKeyToAccount(process.env.AGENTRAIL_OWNER_KEY);
  const wc = createWalletClient({ account: ownerAcct, chain: TESTNET_CFG.chain, transport: http(TESTNET_RPC) });
  const pc = createPublicClient({ chain: TESTNET_CFG.chain, transport: http(TESTNET_RPC) });
  console.log('owner:', ownerAcct.address);
  const hash = await wc.sendTransaction({ to: REG, data: grantData });
  console.log('GRANT TX HASH:', hash);
  const rcpt = await pc.waitForTransactionReceipt({ hash });
  console.log('status:', rcpt.status, 'block:', rcpt.blockNumber);
  // MANDATORY verification - never trust a non-reverting tx
  const chk = await ex.client.isApprovedForPool({
    pool: POOL, owner: ownerAcct.address, operator: operator.address, selector: SEL.placeOrderFor });
  console.log('isApprovedForPool AFTER grant =', chk);
  if (chk !== true) { console.log('ABORT: grant did not take effect.'); process.exit(1); }
}

fs.writeFileSync('step2-artifacts.json', JSON.stringify({
  operator: operator.address, pool: POOL, market: m.marketId, registry: REG,
  grantCalldata: grantData, selectors: SEL,
}, null, 2));
console.log('\n-> wrote step2-artifacts.json');
process.exit(0);
