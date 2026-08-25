// STEP 1b: non-revert on a void function is NOT proof of effect. Prove the grant
// on an UNDEPLOYED address actually performs the SSTORE and reads back true.
// READ-ONLY: debug_traceCall + eth_call with a stateDiff override. Nothing sent.
import { rpc } from './rpc.mjs';
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import fs from 'node:fs';

const prev = JSON.parse(fs.readFileSync('STEP1-RESULT.json', 'utf8'));
const REG = prev.registry, OP = prev.operator, SELS = prev.selectors;
const TARGET = prev.target.addr;
const CALLER = '0xAAaA000000000000000000000000000000000001';
const OTHER = '0xcccc000000000000000000000000000000000003';

const ABI = [
  { name: 'setOperatorApprovalForPool', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'bytes4[]' }, { type: 'bool' }], outputs: [] },
  { name: 'isApprovedForPool', type: 'function', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes4' }],
    outputs: [{ type: 'bool' }] },
];

const grant = encodeFunctionData({ abi: ABI, functionName: 'setOperatorApprovalForPool',
  args: [TARGET, OP, SELS, true] });

const out = { step: '1b', target: TARGET, undeployedCodeLen: prev.target.codeLen, caller: CALLER };

console.log('=== trace the grant on UNDEPLOYED pool', TARGET, '===');
let storage = {};
try {
  const t = await rpc('debug_traceCall', [
    { from: CALLER, to: REG, data: grant, gas: '0x2000000' }, 'latest',
    { tracer: 'prestateTracer', tracerConfig: { diffMode: true } },
  ]);
  storage = (t.post?.[REG.toLowerCase()] || {}).storage || {};
  const written = Object.entries(storage);
  const ones = written.filter(([, v]) => BigInt(v) === 1n);
  out.traceOk = true;
  out.slotsWritten = written.length;
  out.slotsSetToOne = ones.length;
  out.slots = written.map(([k, v]) => ({ slot: k, value: v }));
  console.log(`  slots written: ${written.length}, set to 1: ${ones.length}`);
  written.forEach(([k, v]) => console.log(`    ${k} = ${v}`));
} catch (e) {
  out.traceOk = false; out.traceError = String(e.message);
  console.log('  debug_traceCall unavailable/failed:', e.message);
}

// read back the granted state under the override, keyed by caller vs someone else
if (out.traceOk && out.slotsWritten > 0) {
  out.readback = [];
  for (const [label, owner] of [['owner=CALLER', CALLER], ['owner=OTHER', OTHER]]) {
    const read = encodeFunctionData({ abi: ABI, functionName: 'isApprovedForPool',
      args: [TARGET, owner, OP, SELS[0]] });
    const r = await rpc('eth_call', [{ to: REG, data: read }, 'latest', { [REG]: { stateDiff: storage } }]);
    const v = decodeFunctionResult({ abi: ABI, functionName: 'isApprovedForPool', data: r });
    out.readback.push({ label, owner, raw: r, decoded: v });
    console.log(`  isApprovedForPool(${label}, sel=${SELS[0]}) = ${v}`);
  }
  // and all three selectors for the caller
  out.perSelector = [];
  for (const s of SELS) {
    const read = encodeFunctionData({ abi: ABI, functionName: 'isApprovedForPool',
      args: [TARGET, CALLER, OP, s] });
    const r = await rpc('eth_call', [{ to: REG, data: read }, 'latest', { [REG]: { stateDiff: storage } }]);
    const v = decodeFunctionResult({ abi: ABI, functionName: 'isApprovedForPool', data: r });
    out.perSelector.push({ selector: s, decoded: v });
    console.log(`  selector ${s} -> ${v}`);
  }
}

fs.writeFileSync('STEP1B-RESULT.json', JSON.stringify(out, null, 2));
console.log('\n-> wrote STEP1B-RESULT.json');
