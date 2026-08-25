// STEP 2: compose 3 setOperatorApprovalForPool calls (for the 3 predicted,
// undeployed pool addresses from STEP 1) into ONE Safe MultiSend transaction and
// determine WHOSE identity the registry records as `owner`.
//
// This is the decisive question: registry grants are keyed by msg.sender, so if
// batching does not preserve the intended owner's identity, the batch is useless.
//
// READ-ONLY: eth_call / debug_traceCall with state overrides. Nothing broadcast.
import { rpc } from './rpc.mjs';
import { encodeFunctionData, decodeFunctionResult, encodePacked } from 'viem';
import fs from 'node:fs';

const step1 = JSON.parse(fs.readFileSync('STEP1-RESULT.json', 'utf8'));
const REG = step1.registry;
const OP = step1.operator;
const SELS = step1.selectors;
const POOLS = step1.predicted.map(p => p.addr);   // nonces 940 / 942 / 944, all codeLen 0

const EOA = '0xAAaA000000000000000000000000000000000001';   // the "actual signer"
const SAFE = '0xdddd000000000000000000000000000000000004';  // synthetic Safe address

const MS = {
  'MultiSend 1.4.1':          '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
  'MultiSendCallOnly 1.4.1':  '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
  'MultiSend 1.3.0':          '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761',
  'MultiSendCallOnly 1.3.0':  '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
};

const REG_ABI = [
  { name: 'setOperatorApprovalForPool', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'bytes4[]' }, { type: 'bool' }], outputs: [] },
  { name: 'isApprovedForPool', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes4' }],
    outputs: [{ type: 'bool' }] },
];
const MS_ABI = [{ name: 'multiSend', type: 'function', stateMutability: 'payable',
  inputs: [{ name: 'transactions', type: 'bytes' }], outputs: [] }];

const out = { step: 2, registry: REG, operator: OP, selectors: SELS, pools: POOLS, eoa: EOA, safe: SAFE };

// ---- build the 3 grants and pack them into one multiSend payload -------------
const grants = POOLS.map(pool => encodeFunctionData({
  abi: REG_ABI, functionName: 'setOperatorApprovalForPool', args: [pool, OP, SELS, true] }));
// MultiSend tx encoding, packed: operation(uint8=0 CALL) | to(address) | value(uint256) | len(uint256) | data
const packed = '0x' + grants.map(d => encodePacked(
  ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
  [0, REG, 0n, BigInt((d.length - 2) / 2), d]).slice(2)).join('');
const msData = encodeFunctionData({ abi: MS_ABI, functionName: 'multiSend', args: [packed] });
out.grantCalldatas = grants;
out.multiSendPayloadPacked = packed;
out.multiSendCalldata = msData;
console.log('3 grants packed into one multiSend payload, calldata len =', (msData.length - 2) / 2, 'bytes');

// ---- code presence for each MultiSend flavour --------------------------------
out.multiSendCode = {};
for (const [name, addr] of Object.entries(MS)) {
  const c = await rpc('eth_getCode', [addr, 'latest']);
  out.multiSendCode[name] = { addr, codeLen: (c.length - 2) / 2 };
  console.log(`  ${name.padEnd(26)} ${addr} codeLen=${(c.length - 2) / 2}`);
}

// ---- helper: given a storage diff, work out which address it keyed the grant to
async function whoIsOwner(storage, candidates) {
  const res = [];
  for (const [label, owner] of candidates) {
    const read = encodeFunctionData({ abi: REG_ABI, functionName: 'isApprovedForPool',
      args: [POOLS[0], owner, OP, SELS[0]] });
    const r = await rpc('eth_call', [{ to: REG, data: read }, 'latest', { [REG]: { stateDiff: storage } }]);
    const v = decodeFunctionResult({ abi: REG_ABI, functionName: 'isApprovedForPool', data: r });
    res.push({ label, owner, decoded: v });
  }
  return res;
}
// count how many of the 3 pools x 3 selectors are approved for a given owner
async function coverage(storage, owner) {
  let n = 0; const detail = [];
  for (const pool of POOLS) for (const s of SELS) {
    const read = encodeFunctionData({ abi: REG_ABI, functionName: 'isApprovedForPool',
      args: [pool, owner, OP, s] });
    const r = await rpc('eth_call', [{ to: REG, data: read }, 'latest', { [REG]: { stateDiff: storage } }]);
    const v = decodeFunctionResult({ abi: REG_ABI, functionName: 'isApprovedForPool', data: r });
    if (v) n++; detail.push({ pool, selector: s, decoded: v });
  }
  return { approvedCount: n, of: POOLS.length * SELS.length, detail };
}

out.variants = [];

// ================ VARIANT A: EOA calls MultiSend DIRECTLY =====================
// Models the "naive relayed multicall". Inner CALLs originate from whatever
// address the MultiSend code is executing at -> the MultiSend contract itself.
for (const [name, addr] of Object.entries(MS)) {
  const v = { variant: 'A-direct-call', multiSend: name, multiSendAddr: addr, from: EOA };
  try {
    const t = await rpc('debug_traceCall', [
      { from: EOA, to: addr, data: msData, gas: '0x2000000' }, 'latest',
      { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }]);
    const storage = (t.post?.[REG.toLowerCase()] || {}).storage || {};
    v.ok = true;
    v.slotsWritten = Object.keys(storage).length;
    v.slotsSetToOne = Object.values(storage).filter(x => BigInt(x) === 1n).length;
    v.ownerProbe = await whoIsOwner(storage, [
      ['EOA (the actual signer)', EOA],
      ['the MultiSend contract',  addr.toLowerCase()],
    ]);
    v.coverageForEoa = (await coverage(storage, EOA)).approvedCount;
    v.coverageForMultiSend = (await coverage(storage, addr.toLowerCase())).approvedCount;
    console.log(`\n[A] ${name}: slots=${v.slotsWritten} ones=${v.slotsSetToOne}`);
    v.ownerProbe.forEach(p => console.log(`     owner=${p.label.padEnd(24)} -> ${p.decoded}`));
    console.log(`     coverage: EOA ${v.coverageForEoa}/9, MultiSend ${v.coverageForMultiSend}/9`);
  } catch (e) {
    v.ok = false; v.error = String(e.message);
    console.log(`\n[A] ${name}: REVERT/ERROR -> ${v.error.slice(0, 220)}`);
  }
  out.variants.push(v);
}

// ========= VARIANT B: Safe-style DELEGATECALL to MultiSend ====================
// Modelled faithfully by overriding the Safe address's code with MultiSend's
// bytecode: the MultiSend logic then executes in the Safe's context, so its inner
// CALLs carry msg.sender = the Safe. This is exactly Safe.execTransaction with
// operation=DelegateCall to MultiSend.
const msCode = await rpc('eth_getCode', [MS['MultiSend 1.4.1'], 'latest']);
out.variantB_codeSource = { from: MS['MultiSend 1.4.1'], codeLen: (msCode.length - 2) / 2 };
{
  const v = { variant: 'B-safe-delegatecall', multiSend: 'MultiSend 1.4.1 code at Safe addr',
              safe: SAFE, from: EOA };
  try {
    const t = await rpc('debug_traceCall', [
      { from: EOA, to: SAFE, data: msData, gas: '0x2000000' }, 'latest',
      { tracer: 'prestateTracer', tracerConfig: { diffMode: true },
        stateOverrides: { [SAFE]: { code: msCode } } }]);
    const storage = (t.post?.[REG.toLowerCase()] || {}).storage || {};
    v.ok = true;
    v.slotsWritten = Object.keys(storage).length;
    v.slotsSetToOne = Object.values(storage).filter(x => BigInt(x) === 1n).length;
    v.ownerProbe = await whoIsOwner(storage, [
      ['the Safe',                SAFE],
      ['EOA (the actual signer)', EOA],
      ['the MultiSend singleton', MS['MultiSend 1.4.1'].toLowerCase()],
    ]);
    const cSafe = await coverage(storage, SAFE);
    v.coverageForSafe = cSafe.approvedCount;
    v.coverageDetail = cSafe.detail;
    v.coverageForEoa = (await coverage(storage, EOA)).approvedCount;
    console.log(`\n[B] Safe-delegatecall: slots=${v.slotsWritten} ones=${v.slotsSetToOne}`);
    v.ownerProbe.forEach(p => console.log(`     owner=${p.label.padEnd(24)} -> ${p.decoded}`));
    console.log(`     coverage: Safe ${v.coverageForSafe}/9, EOA ${v.coverageForEoa}/9`);
  } catch (e) {
    v.ok = false; v.error = String(e.message);
    console.log(`\n[B] Safe-delegatecall: ERROR -> ${v.error.slice(0, 300)}`);
  }
  out.variants.push(v);
}

fs.writeFileSync('STEP2-RESULT.json', JSON.stringify(out, null, 2));
console.log('\n-> wrote STEP2-RESULT.json');
