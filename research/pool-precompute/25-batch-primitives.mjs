import { rpc } from './rpc.mjs';
import { encodeFunctionData, decodeFunctionResult, getContractAddress } from 'viem';
const probes={
 'MultiSend 1.4.1':'0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526',
 'MultiSendCallOnly 1.4.1':'0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
 'MultiSend 1.3.0':'0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761',
 'MultiSendCallOnly 1.3.0':'0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
 'Safe singleton 1.3.0':'0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552',
 'SafeProxyFactory 1.3.0':'0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
 'SimpleAccountFactory(4337 sample)':'0x9406Cc6185a346906296840746125a0E44976454',
};
console.log('Safe / AA batching primitives on Somnia mainnet:');
for(const [n,a] of Object.entries(probes)){
  const c=await rpc('eth_getCode',[a,'latest']);
  console.log(`  ${n.padEnd(34)} ${a} codeLen=${(c.length-2)/2}`);
}
console.log('\n=== PROOF: grant owner == msg.sender (so batching MUST preserve caller) ===');
const REG='0xE7a190736B6024a4DbafadC04E283075877005ce';
const ABI=[
 {name:'setOperatorApprovalForPool',type:'function',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'bytes4[]'},{type:'bool'}],outputs:[]},
 {name:'isApprovedForPool',type:'function',stateMutability:'view',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'bytes4'}],outputs:[{type:'bool'}]}];
const POOL=getContractAddress({from:'0x1a478019Ae4d24249a962934af0f129CE98B5e6f',nonce:860n});
const OP='0x1111111111111111111111111111111111111111';
const SELS=['0x5d97c566','0xe37b444b','0x364c2587'];
const grant=encodeFunctionData({abi:ABI,functionName:'setOperatorApprovalForPool',args:[POOL,OP,SELS,true]});
for(const caller of ['0xaaaa000000000000000000000000000000000001','0xbbbb000000000000000000000000000000000002']){
  const t=await rpc('debug_traceCall',[{from:caller,to:REG,data:grant,gas:'0x2000000'},'latest',{tracer:'prestateTracer',tracerConfig:{diffMode:true}}]);
  const w=(t.post?.[REG.toLowerCase()]||{}).storage||{};
  const slots=Object.entries(w).filter(([k,v])=>BigInt(v)===1n).map(([k])=>k);
  console.log(`  caller ${caller} -> approved-slots ${slots.length}: ${slots[0]}`);
  // read back under override, keyed by THAT caller as owner
  const read=encodeFunctionData({abi:ABI,functionName:'isApprovedForPool',args:[POOL,caller,OP,SELS[0]]});
  const r=await rpc('eth_call',[{to:REG,data:read},'latest',{[REG]:{stateDiff:w}}]);
  const readOther=encodeFunctionData({abi:ABI,functionName:'isApprovedForPool',args:[POOL,'0xcccc000000000000000000000000000000000003',OP,SELS[0]]});
  const r2=await rpc('eth_call',[{to:REG,data:readOther},'latest',{[REG]:{stateDiff:w}}]);
  console.log(`     isApprovedForPool(owner=caller)=${decodeFunctionResult({abi:ABI,functionName:'isApprovedForPool',data:r})}  (owner=someone else)=${decodeFunctionResult({abi:ABI,functionName:'isApprovedForPool',data:r2})}`);
}
console.log('\n=== can placeBinaryOrderFor selector be granted alongside legacy? (bytes4[] length test) ===');
const many=['0x5d97c566','0x80054449','0xe37b444b','0x364c2587','0x718c2d4d','0xdbc91396','0x33407b60'];
const g2=encodeFunctionData({abi:ABI,functionName:'setOperatorApprovalForPool',args:[POOL,OP,many,true]});
try{ await rpc('eth_call',[{from:'0xaaaa000000000000000000000000000000000001',to:REG,data:g2},'latest']);
  console.log(`  OK: ${many.length} selectors in ONE call accepted`); }catch(e){ console.log('  revert', String(e.message).slice(0,150)); }
