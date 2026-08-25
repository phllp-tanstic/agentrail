import { rpc } from './rpc.mjs';
const head=parseInt(await rpc('eth_blockNumber',[]),16);
const types={}; let scanned=0, sampled7702=[];
for(let i=0;i<60;i++){
  const bn=head-i*37;
  const b=await rpc('eth_getBlockByNumber',['0x'+bn.toString(16),true]);
  for(const tx of b.transactions||[]){ types[tx.type]=(types[tx.type]||0)+1; scanned++;
    if(tx.type==='0x4') sampled7702.push(tx.hash);
    if(tx.authorizationList) sampled7702.push('authList:'+tx.hash); }
}
console.log(`scanned ${scanned} txs across 60 blocks near head ${head}`);
console.log('tx type histogram:', JSON.stringify(types));
console.log('type-0x04 (EIP-7702 setCode) txs seen:', sampled7702.length, sampled7702.slice(0,4).join(' '));
console.log('\n=== look for 7702 delegation designators (23-byte code starting 0xef0100) among active EOAs ===');
const seen=new Set();
for(let i=0;i<12;i++){
  const b=await rpc('eth_getBlockByNumber',['0x'+(head-i*53).toString(16),true]);
  for(const tx of (b.transactions||[]).slice(0,12)) seen.add(tx.from);
}
let n7702=0, checked=0;
for(const a of [...seen].slice(0,60)){
  const c=await rpc('eth_getCode',[a,'latest']); checked++;
  if(c.startsWith('0xef0100')){ n7702++; console.log(`   7702 DELEGATED: ${a} -> impl 0x${c.slice(8)}`); }
}
console.log(`checked ${checked} distinct tx senders; 7702-delegated: ${n7702}`);
