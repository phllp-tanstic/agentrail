// (a) well-formed type-0x02 vs type-0x04 RLP acceptance probe
// (b) scan recent blocks for tx types + hunt EIP-7702 delegation designators (0xef0100 + 20 bytes)
import { rpc, MAINNET, TESTNET } from './rpc.mjs';
import { toRlp, numberToHex } from 'viem';

const h = (n) => n === 0 ? '0x' : numberToHex(n); // RLP minimal-int encoding

function type02() {
  return '0x02' + toRlp([
    h(5031), h(0), h(1), h(1000000000), h(21000),
    '0x000000000000000000000000000000000000dEaD', h(0), '0x', [],
    h(0), '0x0000000000000000000000000000000000000000000000000000000000000001',
           '0x0000000000000000000000000000000000000000000000000000000000000001',
  ]).slice(2);
}
function type04() {
  // authorizationList entry: [chainId, address, nonce, yParity, r, s]
  const auth = [h(5031), '0x000000000000000000000000000000000000dEaD', h(0), h(0),
    '0x0000000000000000000000000000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000000000000000000000000000001'];
  return '0x04' + toRlp([
    h(5031), h(0), h(1), h(1000000000), h(21000),
    '0x000000000000000000000000000000000000dEaD', h(0), '0x', [], [auth],
    h(0), '0x0000000000000000000000000000000000000000000000000000000000000001',
           '0x0000000000000000000000000000000000000000000000000000000000000001',
  ]).slice(2);
}
function type01() {
  return '0x01' + toRlp([
    h(5031), h(0), h(1000000000), h(21000),
    '0x000000000000000000000000000000000000dEaD', h(0), '0x', [],
    h(0), '0x0000000000000000000000000000000000000000000000000000000000000001',
           '0x0000000000000000000000000000000000000000000000000000000000000001',
  ]).slice(2);
}

console.log('=== (a) well-formed raw tx acceptance (dummy sig r=s=1; cannot execute) ===');
for (const [label, raw] of [['type 0x01 (EIP-2930)', type01()], ['type 0x02 (EIP-1559)', type02()],
                            ['type 0x04 (EIP-7702)', type04()]]) {
  for (const [net, url] of [['MAINNET', MAINNET], ['TESTNET', TESTNET]]) {
    try { const r = await rpc('eth_sendRawTransaction', [raw], url); console.log(`  ${net} ${label}: ACCEPTED?! ${r}`); }
    catch (e) { console.log(`  ${net} ${label}: ${String(e.message).replace(/^eth_sendRawTransaction: /, '').slice(0, 190)}`); }
  }
}

console.log('\n=== (b) scan recent blocks: tx type histogram + sender set ===');
const latest = parseInt(await rpc('eth_blockNumber'), 16);
const typeHist = {}, senders = new Set(), sysTx = [];
const NBLOCKS = 400;
let scanned = 0, txs = 0;
for (let i = 0; i < NBLOCKS; i++) {
  const bn = latest - i * 37; // spread the sample
  let b;
  try { b = await rpc('eth_getBlockByNumber', ['0x' + bn.toString(16), true]); } catch { continue; }
  if (!b) continue;
  scanned++;
  for (const t of b.transactions) {
    txs++;
    typeHist[t.type] = (typeHist[t.type] || 0) + 1;
    senders.add(t.from.toLowerCase());
    if (t.r === '0x1' || t.r === '0x01' || BigInt(t.nonce) > 0xffffffffn) {
      sysTx.push({ hash: t.hash, from: t.from, to: t.to, type: t.type, nonce: t.nonce, bn: b.number, r: t.r, s: t.s });
    }
  }
}
console.log(`scanned ${scanned} blocks (sampled from ${latest - NBLOCKS * 37} .. ${latest}), ${txs} txs`);
console.log('tx type histogram:', JSON.stringify(typeHist));
console.log(`unique senders: ${senders.size}`);
console.log(`\ntxs with dummy sig (r==0x1) or huge nonce: ${sysTx.length}`);
const byFrom = {};
for (const t of sysTx) byFrom[t.from.toLowerCase()] = (byFrom[t.from.toLowerCase()] || 0) + 1;
console.log('their senders:', JSON.stringify(byFrom, null, 1));
for (const t of sysTx.slice(0, 8)) console.log(`   ${t.hash} blk=${t.bn} type=${t.type} nonce=${t.nonce} r=${t.r} s=${t.s} from=${t.from} to=${t.to} SAME=${t.from.toLowerCase() === (t.to || '').toLowerCase()}`);

console.log('\n=== (c) hunt EIP-7702 delegation designators among those senders ===');
let checked = 0, delegated = 0, contracts = 0;
for (const a of senders) {
  const code = await rpc('eth_getCode', [a, 'latest']);
  checked++;
  if (code !== '0x') {
    contracts++;
    if (code.startsWith('0xef0100')) { delegated++; console.log(`  *** 7702 DELEGATION: ${a} -> ${code}  (len ${(code.length - 2) / 2})`); }
    else if ((code.length - 2) / 2 === 23) console.log(`  23-byte code (suspicious): ${a} -> ${code}`);
    else console.log(`  sender IS A CONTRACT: ${a} codeLen=${(code.length - 2) / 2}`);
  }
}
console.log(`checked ${checked} senders: ${contracts} have code, ${delegated} are 7702-delegated (0xef0100 prefix)`);
