// VERIFY the brute-forced signatures by executing them via eth_call with properly encoded args.
import { rpc } from './rpc.mjs';
import { encodeFunctionData, decodeFunctionResult, keccak256, toHex } from 'viem';

const REG = '0xE7a190736B6024a4DbafadC04E283075877005ce';
const OWNER_USER = '0x2222222222222222222222222222222222222222'; // pretend user (msg.sender)
const OPERATOR = '0x1111111111111111111111111111111111111111';
const SELS = ['0x80054449', '0xe37b444b', '0x364c2587'];
const POOL = '0x39b910486dbc82510d0990caa8b4af05da864bb4'; // a real deployed pool (from earlier work)

const S = (sig) => keccak256(toHex(sig)).slice(0, 10);

const ABI = [
  { name: 'setOperatorApprovalForPool', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'bytes4[]' }, { type: 'bool' }], outputs: [] },
  { name: 'setOperatorApprovalGlobal', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'bytes4[]' }, { type: 'bool' }], outputs: [] },
  { name: 'isGloballyApproved', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'bytes4' }], outputs: [{ type: 'bool' }] },
  { name: 'isApproved', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'bytes4' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { name: 'isApprovedForPool', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes4' }], outputs: [{ type: 'bool' }] },
];

console.log('=== selector cross-check (keccak of guessed name == observed dispatch entry?) ===');
for (const n of ['setOperatorApprovalForPool(address,address,bytes4[],bool)',
  'setOperatorApprovalGlobal(address,bytes4[],bool)',
  'isGloballyApproved(address,address,bytes4)',
  'isApproved(address,address,bytes4,address)',
  'isApprovedForPool(address,address,address,bytes4)']) console.log(`  ${S(n)}  ${n}`);

async function call(data, from = OWNER_USER, label = '') {
  try { const r = await rpc('eth_call', [{ from, to: REG, data }, 'latest']); return { ok: true, ret: r }; }
  catch (e) { const m = String(e.message).match(/"data":"(0x[0-9a-f]*)"/); return { ok: false, d: m ? m[1] : '' }; }
}
const ERR = { '0xccea9e6f': 'InvalidOperator()', '0x4ae141b2': '0x4ae141b2 (unknown custom error)',
  '': '(EMPTY revert data)', '0x': '(EMPTY revert data)' };
const show = (r) => r.ok ? `OK ret=${r.ret}` : `REVERT ${ERR[r.d] || r.d}`;

console.log('\n=== EXECUTE the guessed functions with REAL encoded args (eth_call, no state change) ===');

const d1 = encodeFunctionData({ abi: ABI, functionName: 'setOperatorApprovalGlobal', args: [OPERATOR, SELS, true] });
console.log('setOperatorApprovalGlobal calldata:', d1);
console.log('  ->', show(await call(d1)));

const d1b = encodeFunctionData({ abi: ABI, functionName: 'setOperatorApprovalGlobal', args: [OPERATOR, SELS, false] });
console.log('  (approved=false) ->', show(await call(d1b)));

const d1c = encodeFunctionData({ abi: ABI, functionName: 'setOperatorApprovalGlobal', args: ['0x0000000000000000000000000000000000000000', SELS, true] });
console.log('  (operator=0x0, expect InvalidOperator) ->', show(await call(d1c)));

const d1d = encodeFunctionData({ abi: ABI, functionName: 'setOperatorApprovalGlobal', args: [OPERATOR, [], true] });
console.log('  (empty selector array) ->', show(await call(d1d)));

const d2 = encodeFunctionData({ abi: ABI, functionName: 'setOperatorApprovalForPool', args: [POOL, OPERATOR, SELS, true] });
console.log('\nsetOperatorApprovalForPool (real pool) ->', show(await call(d2)));
const d2b = encodeFunctionData({ abi: ABI, functionName: 'setOperatorApprovalForPool', args: ['0x000000000000000000000000000000000000dEaD', OPERATOR, SELS, true] });
console.log('setOperatorApprovalForPool (NON-registered pool 0x..dEaD) ->', show(await call(d2b)));

console.log('\n=== views ===');
for (const [fn, args] of [
  ['isGloballyApproved', [OWNER_USER, OPERATOR, SELS[0]]],
  ['isApproved', [OWNER_USER, OPERATOR, SELS[0], POOL]],
  ['isApprovedForPool', [POOL, OWNER_USER, OPERATOR, SELS[0]]],
]) {
  const d = encodeFunctionData({ abi: ABI, functionName: fn, args });
  const r = await call(d);
  console.log(`  ${fn}(${args.join(', ')})`);
  console.log(`     -> ${show(r)}${r.ok ? '  decoded=' + decodeFunctionResult({ abi: ABI, functionName: fn, data: r.ret }) : ''}`);
}

console.log('\n=== the 3 system-tx senders: identical 283-byte contracts? ===');
for (const a of ['0x9653a7355849b7691802a6aa49fde18ef5ba633d',
  '0xed32f048d6a47923d38eced868d6f8b0eb4852bd', '0x68c8f6fb1ea19a28f25358ff00b8ed8e1216df30',
  '0xfe81c4e8effb7df27eb21881f80af2bf8dcf0c39']) {
  const c = await rpc('eth_getCode', [a, 'latest']);
  const impl = await rpc('eth_getStorageAt', [a, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']);
  console.log(`  ${a} codeLen=${(c.length - 2) / 2} eip1967impl=${impl} codeHashPrefix=${keccak256(c).slice(0, 18)}`);
}
