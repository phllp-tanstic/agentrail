import { rpc } from './rpc.mjs';
const IMPL='0x48e523c9f22f98548d263f0ad444d732e5202c0e';           // pool implementation
const REGIMPL='0xefdbf940edcecda6e581ad561eceef735d46f248';        // registry implementation
const REG='0xe7a190736b6024a4dbafadc04e283075877005ce';
const code=(await rpc('eth_getCode',[IMPL,'latest'])).toLowerCase();
console.log('pool impl codeLen',(code.length-2)/2);

console.log('\n-- ground-truth selector 0x80054449 on the binary pool? --');
console.log('  PUSH4 6380054449 present:', code.includes('6380054449'));
console.log('  raw bytes 80054449 present:', code.includes('80054449'));
console.log('  placeBinaryOrderFor 0x5d97c566 PUSH4 present:', code.includes('635d97c566'));

console.log('\n-- does the pool reference the OperatorPermissionsRegistry? --');
console.log('  registry proxy addr in pool impl bytecode:', code.includes(REG.slice(2)));
console.log('  registry impl addr in pool impl bytecode:', code.includes(REGIMPL.slice(2)));
// look for isApprovedForPool selector in ANY form
for(const s of ['03684f95','7bbc67e6']) console.log(`  ${s} in pool impl:`, code.includes(s));
// what other addresses does the pool hardcode? find PUSH20 (0x73) sequences
const hex=code.slice(2); const addrs=new Set();
for(let i=0;i+42<=hex.length;i+=2){ if(hex.slice(i,i+2)==='73'){ const a=hex.slice(i+2,i+42); if(/^[0-9a-f]{40}$/.test(a)&&!/^0{30}/.test(a)) addrs.add('0x'+a);} }
console.log('  PUSH20 candidates in pool impl:', [...addrs].slice(0,12).join(' '));

console.log('\n-- enumerate ALL PUSH4 selectors in the pool implementation --');
const sels=new Set();
for(let i=0;i+10<=hex.length;i+=2){ if(hex.slice(i,i+2)==='63'){ const s=hex.slice(i+2,i+10); if(/^[0-9a-f]{8}$/.test(s)) sels.add('0x'+s);} }
console.log('  distinct PUSH4 values:', sels.size);
// resolve the "*For" operator entrypoints via 4byte
const list=[...sels];
let resolvedFor=[];
for (let i=0;i<list.length;i+=1){
  const s=list[i];
  try{
    const r=await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${s}`).then(r=>r.json());
    const names=(r.results||[]).map(x=>x.text_signature);
    const forSig=names.find(n=>/For\(/.test(n));
    if(forSig) resolvedFor.push(`${s}  ${forSig}`);
  }catch(e){}
  if(i>140) break;   // cap network calls
}
console.log('\n-- operator ("...For(...)") entrypoints resolved on the pool --');
resolvedFor.slice(0,25).forEach(x=>console.log('   ',x));

console.log('\n-- registry implementation selectors --');
const rcode=(await rpc('eth_getCode',[REGIMPL,'latest'])).toLowerCase().slice(2);
const rsels=new Set();
for(let i=0;i+10<=rcode.length;i+=2){ if(rcode.slice(i,i+2)==='63'){ const s=rcode.slice(i+2,i+10); if(/^[0-9a-f]{8}$/.test(s)) rsels.add('0x'+s);} }
console.log('  distinct PUSH4 in registry impl:', rsels.size, '->', [...rsels].join(' '));
console.log('  has multicall(bytes[]) 0xac9650d8:', rsels.has('0xac9650d8'));
console.log('  has setOperatorApprovalForPool 0x7bbc67e6:', rsels.has('0x7bbc67e6'));
