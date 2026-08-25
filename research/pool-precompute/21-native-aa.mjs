import { rpc } from './rpc.mjs';
console.log('=== system address 0x...0100 ===');
for(const a of ['0x0000000000000000000000000000000000000100','0x0000000000000000000000000000000000000101','0x00000000000000000000000000000000000000ff']){
  const c=await rpc('eth_getCode',[a,'latest']);
  console.log(`  ${a} codeLen=${(c.length-2)/2}`, c.slice(0,60));
}
console.log('\n=== is 0xfe81c4e8 (contract tx sender) a 7702 delegate or real contract? ===');
const FE='0xfe81c4e8effb7df27eb21881f80af2bf8dcf0c39';
const c=await rpc('eth_getCode',[FE,'latest']);
console.log('  codeLen', (c.length-2)/2, 'starts 0xef0100 (7702)?', c.startsWith('0xef0100'));
console.log('  nonce (eth_getTransactionCount):', parseInt(await rpc('eth_getTransactionCount',[FE,'latest']),16));

console.log('\n=== recent txs from that account: type + nonce shape ===');
const r = await fetch(`https://explorer.somnia.network/api/v2/addresses/${FE}/transactions?filter=from`).then(r=>r.json()).catch(()=>({items:[]}));
const items=(r.items||[]).slice(0,4);
for(const it of items){
  const tx = await rpc('eth_getTransactionByHash',[it.hash]);
  console.log(`  ${it.hash.slice(0,18)} type=${tx.type} nonce=${tx.nonce} (${BigInt(tx.nonce)}) from=${tx.from} to=${tx.to} v=${tx.v} r=${(tx.r||'').slice(0,12)} yParity=${tx.yParity}`);
  console.log(`     nonce hi=${(BigInt(tx.nonce)>>24n)} lo=${(BigInt(tx.nonce)&0xffffffn)}  gas=${parseInt(tx.gas,16)}`);
}
console.log('\n=== EIP-7702 / 4337 / Safe / Multicall3 presence ===');
const probes = {
 'Multicall3': '0xcA11bde05977b3631167028862bE2a173976CA11',
 'EntryPoint v0.6': '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
 'EntryPoint v0.7': '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
 'EntryPoint v0.8': '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
 'Safe singleton 1.4.1': '0x41675C099F32341bf84BFc5382aF534df5C7461a',
 'SafeProxyFactory 1.4.1': '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
 'CreateX': '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed',
 'CREATE3 factory(Solady-ish)': '0x0000000000FFe8B47B3e2130213B802212439497',
};
for(const [n,a] of Object.entries(probes)){
  const cc=await rpc('eth_getCode',[a,'latest']);
  console.log(`  ${n.padEnd(26)} ${a} codeLen=${(cc.length-2)/2}`);
}
