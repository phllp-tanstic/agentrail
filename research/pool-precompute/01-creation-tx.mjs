import { rpc } from './rpc.mjs';
const TXS = [
  '0x27f23511f1be736eae68acc62d567fde49961ee3a1516716339e0531704a06f7',
  '0x66d3e9aac6751d311a61b2d08b1dc070e47149460ad8e2ac3e0060d22a3c7351',
  '0xc96c93ca8502ac348cebb961031bd0275343f4f1e5b8e82c358757f3f8e8f1c6',
];
for (const h of TXS) {
  const tx = await rpc('eth_getTransactionByHash', [h]);
  const rc = await rpc('eth_getTransactionReceipt', [h]);
  console.log('='.repeat(80));
  console.log('TX', h);
  console.log('  from  ', tx.from);
  console.log('  to    ', tx.to);
  console.log('  block ', parseInt(tx.blockNumber, 16));
  console.log('  selector', tx.input.slice(0, 10), 'inputLen', (tx.input.length - 2) / 2, 'bytes');
  console.log('  input ', tx.input.slice(0, 660));
  console.log('  logs  ', rc.logs.length, 'status', rc.status);
  const byAddr = {};
  for (const l of rc.logs) byAddr[l.address] = (byAddr[l.address] || 0) + 1;
  console.log('  log emitters:', JSON.stringify(byAddr, null, 1));
}
