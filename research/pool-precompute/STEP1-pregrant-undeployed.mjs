// STEP 1: compute next 3 unreleased pool addresses from the deployer's CURRENT
// nonce (even-nonce-only pattern is settled ground truth, not re-derived here),
// then eth_call-simulate setOperatorApprovalForPool against one of them.
// READ-ONLY. No transaction is signed or sent anywhere in this file.
import { rpc, MAINNET } from './rpc.mjs';
import { encodeFunctionData, decodeFunctionResult, getContractAddress } from 'viem';
import fs from 'node:fs';

const DEPLOYER = '0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
const REG = '0xE7a190736B6024a4DbafadC04E283075877005ce'; // mainnet OperatorPermissionsRegistry
const OP = '0x9905123B35A841F34CEBE437289bb195ef24DA14'; // operator from step2-artifacts
const SELS = ['0x5d97c566', '0xe37b444b', '0x364c2587']; // real binary order sel + cancel + reduce

const ABI = [
  { name: 'setOperatorApprovalForPool', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'pool', type: 'address' }, { name: 'operator', type: 'address' },
             { name: 'selectors', type: 'bytes4[]' }, { name: 'approved', type: 'bool' }], outputs: [] },
  { name: 'isApprovedForPool', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'pool', type: 'address' }, { name: 'owner', type: 'address' },
             { name: 'operator', type: 'address' }, { name: 'selector', type: 'bytes4' }],
    outputs: [{ type: 'bool' }] },
];

const out = { step: 1, deployer: DEPLOYER, registry: REG, operator: OP, selectors: SELS };

// --- current nonce -----------------------------------------------------------
const nonceHex = await rpc('eth_getTransactionCount', [DEPLOYER, 'latest']);
const nonce = Number(BigInt(nonceHex));
const blockHex = await rpc('eth_blockNumber', []);
out.currentNonceHex = nonceHex;
out.currentNonce = nonce;
out.atBlock = Number(BigInt(blockHex));
console.log('deployer            :', DEPLOYER);
console.log('current nonce       :', nonce, `(${nonceHex})  at block ${out.atBlock}`);

// --- next 3 UNRELEASED even nonces ------------------------------------------
let n = nonce % 2 === 0 ? nonce : nonce + 1;
const targets = [];
for (let i = 0; i < 3; i++, n += 2) {
  const addr = getContractAddress({ from: DEPLOYER, nonce: BigInt(n) });
  const code = await rpc('eth_getCode', [addr, 'latest']);
  const codeLen = (code.length - 2) / 2;
  targets.push({ nonce: n, addr, codeLen, undeployed: codeLen === 0 });
  console.log(`  nonce ${String(n).padEnd(5)} -> ${addr}  codeLen=${codeLen} ${codeLen === 0 ? 'UNDEPLOYED' : '*** HAS CODE ***'}`);
}
out.predicted = targets;

// --- positive control: a KNOWN real pool must reproduce from its nonce -------
const CONTROL = { nonce: 274, expect: '0x843ca845bbad0db0954700264901de5e451940ae' };
const controlAddr = getContractAddress({ from: DEPLOYER, nonce: BigInt(CONTROL.nonce) });
const controlCode = await rpc('eth_getCode', [controlAddr, 'latest']);
out.control = {
  nonce: CONTROL.nonce, expected: CONTROL.expect, computed: controlAddr,
  match: controlAddr.toLowerCase() === CONTROL.expect.toLowerCase(),
  codeLen: (controlCode.length - 2) / 2,
};
console.log('\npositive control (nonce 274):', controlAddr,
  out.control.match ? 'MATCHES known real pool' : 'MISMATCH', `codeLen=${out.control.codeLen}`);

// --- the actual question: does the registry accept a grant on 0-code addr? ---
const TARGET = targets[0];
const grant = encodeFunctionData({
  abi: ABI, functionName: 'setOperatorApprovalForPool',
  args: [TARGET.addr, OP, SELS, true],
});
out.target = TARGET;
out.grantCalldata = grant;
console.log('\n=== eth_call setOperatorApprovalForPool on UNDEPLOYED', TARGET.addr, '===');
console.log('calldata:', grant);

// simulate from two distinct synthetic callers (no keys, nothing is written)
const CALLERS = [
  '0xAAaA000000000000000000000000000000000001',
  '0xbBBb000000000000000000000000000000000002',
];
out.sims = [];
for (const from of CALLERS) {
  const rec = { from };
  try {
    const r = await rpc('eth_call', [{ from, to: REG, data: grant, gas: '0x2000000' }, 'latest']);
    rec.ok = true; rec.result = r;
    console.log(`  from ${from} -> NO REVERT, returned ${r === '0x' ? '0x (void fn)' : r}`);
  } catch (e) {
    rec.ok = false; rec.error = String(e.message);
    console.log(`  from ${from} -> REVERT: ${rec.error}`);
  }
  out.sims.push(rec);
}

// --- negative/positive control on the SIM itself: same call on a REAL pool ---
const grantReal = encodeFunctionData({
  abi: ABI, functionName: 'setOperatorApprovalForPool',
  args: [CONTROL.expect, OP, SELS, true],
});
try {
  const r = await rpc('eth_call', [{ from: CALLERS[0], to: REG, data: grantReal, gas: '0x2000000' }, 'latest']);
  out.realPoolSim = { ok: true, result: r, pool: CONTROL.expect };
  console.log(`\ncontrol sim on REAL pool ${CONTROL.expect} -> NO REVERT (${r})`);
} catch (e) {
  out.realPoolSim = { ok: false, error: String(e.message), pool: CONTROL.expect };
  console.log(`\ncontrol sim on REAL pool -> REVERT: ${e.message}`);
}

// --- pre-state read: must be false before any grant --------------------------
const read = encodeFunctionData({ abi: ABI, functionName: 'isApprovedForPool',
  args: [TARGET.addr, CALLERS[0], OP, SELS[0]] });
try {
  const r = await rpc('eth_call', [{ to: REG, data: read }, 'latest']);
  out.preState = { raw: r, decoded: decodeFunctionResult({ abi: ABI, functionName: 'isApprovedForPool', data: r }) };
  console.log('isApprovedForPool BEFORE (expect false):', out.preState.decoded, `raw=${r}`);
} catch (e) {
  out.preState = { error: String(e.message) };
  console.log('isApprovedForPool BEFORE -> REVERT:', e.message);
}

fs.writeFileSync('STEP1-RESULT.json', JSON.stringify(out, null, 2));
console.log('\n-> wrote STEP1-RESULT.json');
