// STEP 2c-ii: the gate reads ONE slot in the POOL's own storage:
//   0x8e15f0fff8607b3d9deef83a7bb516ae831cbeeff9c9cb249b4a76e62ab5d9f7 = 0
// Work out how that slot is derived (which key, which base slot), and hunt for the
// getter/setter that administers it on the implementation contract.
// READ-ONLY.
import { keccak256, encodeAbiParameters, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';

const TARGET = '0x8e15f0fff8607b3d9deef83a7bb516ae831cbeeff9c9cb249b4a76e62ab5d9f7';
const OWNER = privateKeyToAccount('0x' + '11'.repeat(32)).address;      // order `owner` arg
const OPERATOR = '0xf790ece943559b79e17d327885df0ba94cf68151';          // msg.sender in the trace
const POOL_T = '0xc09e4a5bdee2899962727125fb5eaeb896798e46';
const IMPL = '0x48e523c9f22f98548d263f0ad444d732e5202c0e';
const MODULE = '0x3ecC694Cef705358864a646142ac17A90E29e388';

const out = { target: TARGET, candidates: [] };
const slot1 = (key, p) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'uint256' }], [key, BigInt(p)]));
const slot2 = (k1, k2, p) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'bytes32' }], [k2, slot1(k1, p)]));

console.log('hunting derivation of', TARGET);
const KEYS = { OWNER, OPERATOR, POOL_T, IMPL, MODULE, ZERO: '0x0000000000000000000000000000000000000000' };
for (const [kn, k] of Object.entries(KEYS)) {
  for (let p = 0; p < 200; p++) {
    if (slot1(k, p).toLowerCase() === TARGET) {
      out.candidates.push({ kind: 'mapping(address=>X)', key: kn, keyAddr: k, baseSlot: p });
      console.log(`  MATCH single: mapping at slot ${p}, key = ${kn} (${k})`);
    }
  }
}
for (const [n1, k1] of Object.entries(KEYS)) for (const [n2, k2] of Object.entries(KEYS)) {
  for (let p = 0; p < 60; p++) {
    if (slot2(k1, k2, p).toLowerCase() === TARGET) {
      out.candidates.push({ kind: 'mapping(address=>mapping(address=>X))', outer: n1, inner: n2, baseSlot: p });
      console.log(`  MATCH nested: base slot ${p}, outer=${n1}, inner=${n2}`);
    }
  }
}
if (!out.candidates.length) console.log('  no match for plain address-keyed mapping in slots scanned');

// ---- selector hunt on the implementation bytecode ---------------------------
const code = await (await fetch('https://api.infra.testnet.somnia.network', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [IMPL, 'latest'] }),
})).json();
const hex = (code.result || '').toLowerCase();
out.implCodeLen = (hex.length - 2) / 2;
const NAMES = [
  'setApprovedContract(address,bool)', 'setApprovedContracts(address[],bool)',
  'approveContract(address)', 'isApprovedContract(address)', 'approvedContracts(address)',
  'setOperator(address,bool)', 'isOperator(address,address)', 'operator(address)',
  'setApproved(address,bool)', 'isApproved(address)', 'approved(address)',
  'setOperatorApproval(address,bool)', 'setTrustedForwarder(address)',
  'addApprovedContract(address)', 'removeApprovedContract(address)',
  'setPermissionsRegistry(address)', 'permissionsRegistry()', 'operatorRegistry()',
  'setRouter(address)', 'router()', 'setWhitelist(address,bool)', 'whitelist(address)',
];
out.selectorHits = [];
for (const n of NAMES) {
  const s = toFunctionSelector(n).slice(2);
  if (hex.includes(s)) { out.selectorHits.push({ name: n, selector: '0x' + s }); console.log(`  present in impl: 0x${s}  ${n}`); }
}
if (!out.selectorHits.length) console.log('  none of the guessed selector names appear in impl bytecode');

fs.writeFileSync('STEP2C-II-RESULT.json', JSON.stringify(out, null, 2));
console.log('\n-> wrote STEP2C-II-RESULT.json');
