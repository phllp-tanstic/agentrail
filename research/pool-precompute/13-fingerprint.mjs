// Fingerprint the 7 unknown registry functions: calldata-arity probing + owner-gating probe.
import { rpc } from './rpc.mjs';

const REG = '0xE7a190736B6024a4DbafadC04E283075877005ce';
const OWNER = '0xe4017a9ae28edf3a243246f436200b83031bbcd5'; // from owner()
const RANDO = '0x2222222222222222222222222222222222222222';

const KNOWN = {
  '0x03684f95': 'isApprovedForPool(address,address,address,bytes4)',
  '0x485cc955': 'initialize(address,address)',
  '0x4f1ef286': 'upgradeToAndCall(address,bytes) [UUPS]',
  '0x52d1902d': 'proxiableUUID() [UUPS]',
  '0x715018a6': 'renounceOwnership()',
  '0x79ba5097': 'acceptOwnership()',
  '0x7bbc67e6': 'setOperatorApprovalForPool(address,address,bytes4[],bool)',
  '0x8da5cb5b': 'owner()',
  '0xad3cb1cc': 'UPGRADE_INTERFACE_VERSION()',
  '0xe30c3978': 'pendingOwner()',
  '0xf2fde38b': 'transferOwnership(address)',
};
const ERRNAMES = {
  '0x118cdaa7': 'OwnableUnauthorizedAccount(address)',
  '0xccea9e6f': 'InvalidOperator()',
  '0xe07c8dba': 'UUPSUnauthorizedCallContext()',
  '0xf92ee8a9': 'InvalidInitialization()',
  '0x4e487b71': 'Panic(uint256)',
  '0x1e4fbdf7': 'OwnableInvalidOwner(address)',
  '': '(empty - abi decode fail / no function)',
};
const DISPATCH = ['0x03684f95','0x3a0afa7f','0x4381b341','0x443635a3','0x485cc955','0x4f1ef286',
  '0x52d1902d','0x715018a6','0x79ba5097','0x7bbc67e6','0x7f1e31ce','0x8da5cb5b','0xad3cb1cc',
  '0xaf1e64a8','0xccb0797d','0xcdf7260d','0xe30c3978','0xf2fde38b'];
const UNKNOWN = DISPATCH.filter(s => !KNOWN[s]);
const Z = '0'.repeat(64);

async function call(to, data, from) {
  try { return { ok: true, ret: await rpc('eth_call', [{ from, to, data }, 'latest']) }; }
  catch (e) {
    const m = String(e.message).match(/"data":"(0x[0-9a-f]*)"/);
    const d = m ? m[1] : '';
    return { ok: false, sel: d.slice(0, 10), data: d };
  }
}
const fmt = (r) => r.ok
  ? `OK retLen=${(r.ret.length - 2) / 2}${r.ret.length <= 200 ? ' ' + r.ret : ''}`
  : `REVERT ${ERRNAMES[r.sel] || ERRNAMES[r.data] || r.sel || '0x(empty)'}${r.data.length > 10 ? ' arg=' + r.data.slice(10, 74) : ''}`;

console.log('=== UNKNOWN selectors:', UNKNOWN.join(' '), '\n');
for (const s of UNKNOWN) {
  console.log(`--- ${s} ---`);
  for (let k = 0; k <= 6; k++) {
    const r = await call(REG, s + Z.repeat(k), RANDO);
    console.log(`   ${k} word(s) from RANDO : ${fmt(r)}`);
  }
  // owner-gating check at the arity that first stopped failing with empty data
  for (let k = 0; k <= 6; k++) {
    const rr = await call(REG, s + Z.repeat(k), RANDO);
    const ro = await call(REG, s + Z.repeat(k), OWNER);
    if (JSON.stringify(rr) !== JSON.stringify(ro)) {
      console.log(`   >> DIFFERS by caller at ${k} words: RANDO=${fmt(rr)} | OWNER=${fmt(ro)}`);
    }
  }
  console.log();
}

console.log('=== control: known fns for comparison ===');
for (const [s, name] of Object.entries(KNOWN)) {
  const r0 = await call(REG, s, RANDO);
  console.log(`${s} ${name.padEnd(58)} 0-word: ${fmt(r0)}`);
}
console.log('\n=== control: nonexistent selectors ===');
for (const s of ['0xdeadbeef', '0xac9650d8', '0x00000000', '0xc3c5a547']) {
  console.log(`${s} 0-word: ${fmt(await call(REG, s, RANDO))}  6-word: ${fmt(await call(REG, s + Z.repeat(6), RANDO))}`);
}
