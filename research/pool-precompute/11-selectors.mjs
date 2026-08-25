// Extract 4-byte selectors from runtime bytecode dispatch table + resolve via 4byte.directory
import { rpc } from './rpc.mjs';
import fs from 'fs';

const which = process.argv[2] || '0xefdBF940EDcecDA6e581Ad561ecEEF735d46f248';
const code = await rpc('eth_getCode', [which, 'latest']);
const hex = code.slice(2);
console.log(`target ${which}  codeLen=${hex.length / 2} bytes`);

// Walk opcodes properly so PUSH data is skipped (avoids false PUSH4 hits inside PUSH32 data).
const bytes = Buffer.from(hex, 'hex');
const push4 = new Set();
const order = [];
for (let i = 0; i < bytes.length; i++) {
  const op = bytes[i];
  if (op === 0x63) { // PUSH4
    const sel = '0x' + bytes.slice(i + 1, i + 5).toString('hex');
    if (!push4.has(sel)) { push4.add(sel); order.push(sel); }
    i += 4;
  } else if (op >= 0x60 && op <= 0x7f) {
    i += op - 0x5f; // skip PUSH data
  }
}
console.log(`PUSH4 immediates found (opcode-walked, unique): ${order.length}`);

// Heuristic filter: real selectors are compared against the calldata word. Drop obvious
// non-selectors like 0xffffffff, 0x00000000, and revert-string lengths.
const junk = new Set(['0x00000000', '0xffffffff', '0x01ffc9a7'.toLowerCase()]);
const cands = order.filter(s => !['0x00000000', '0xffffffff'].includes(s));

const out = [];
for (const sel of cands) {
  let names = [];
  try {
    const r = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${sel}`);
    const j = await r.json();
    names = (j.results || []).map(x => x.text_signature);
  } catch (e) { names = ['<4byte lookup failed: ' + e.message + '>']; }
  out.push({ sel, names });
  console.log(`${sel}  ${names.length ? names.join('  ||  ') : '*** UNRESOLVED ***'}`);
  await new Promise(r => setTimeout(r, 120));
}
fs.writeFileSync(`selectors-${which.slice(2, 10)}.json`, JSON.stringify(out, null, 2));
console.log('\nUNRESOLVED:', out.filter(o => !o.names.length).map(o => o.sel).join(' '));
