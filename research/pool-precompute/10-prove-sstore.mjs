// Prove the grant actually writes storage for an UNDEPLOYED pool, and that
// isApprovedForPool then reads true -- using state-override / simulation.
import { rpc } from './rpc.mjs';
import { encodeFunctionData, decodeFunctionResult, getContractAddress } from 'viem';
const REG='0xE7a190736B6024a4DbafadC04E283075877005ce';
const OWNER='0x2222222222222222222222222222222222222222';
const OPERATOR='0x1111111111111111111111111111111111111111';
const SELS=['0x80054449','0xe37b444b','0x364c2587'];
const ABI=[
 {name:'setOperatorApprovalForPool',type:'function',stateMutability:'nonpayable',inputs:[{name:'pool',type:'address'},{name:'operator',type:'address'},{name:'selectors',type:'bytes4[]'},{name:'approved',type:'bool'}],outputs:[]},
 {name:'isApprovedForPool',type:'function',stateMutability:'view',inputs:[{name:'pool',type:'address'},{name:'owner',type:'address'},{name:'operator',type:'address'},{name:'selector',type:'bytes4'}],outputs:[{type:'bool'}]},
];
const FUTURE = getContractAddress({from:'0x1a478019Ae4d24249a962934af0f129CE98B5e6f', nonce:830n});
console.log('target UNDEPLOYED pool =', FUTURE, 'code =', await rpc('eth_getCode',[FUTURE,'latest']));

console.log('\n-- node capability probe --');
for (const m of ['web3_clientVersion','eth_simulateV1','debug_traceCall']) {
  try {
    let r;
    if (m==='web3_clientVersion') r = await rpc(m,[]);
    else if (m==='eth_simulateV1') r = JSON.stringify(await rpc(m,[{blockStateCalls:[{calls:[]}]},'latest'])).slice(0,120);
    else r = JSON.stringify(await rpc(m,[{from:OWNER,to:REG,data:'0x'},'latest',{tracer:'prestateTracer'}])).slice(0,200);
    console.log(`  ${m}: SUPPORTED -> ${r}`);
  } catch(e){ console.log(`  ${m}: ${String(e.message).slice(0,160)}`); }
}

const grantData = encodeFunctionData({abi:ABI,functionName:'setOperatorApprovalForPool',args:[FUTURE,OPERATOR,SELS,true]});
const readData  = encodeFunctionData({abi:ABI,functionName:'isApprovedForPool',args:[FUTURE,OWNER,OPERATOR,SELS[0]]});

console.log('\n-- baseline isApprovedForPool (before any grant) --');
try { const r=await rpc('eth_call',[{from:OWNER,to:REG,data:readData},'latest']);
  console.log('  =', decodeFunctionResult({abi:ABI,functionName:'isApprovedForPool',data:r})); }
catch(e){ console.log('  REVERT', String(e.message).slice(0,160)); }

console.log('\n-- eth_simulateV1: grant then read in ONE sequential simulation --');
try {
  const res = await rpc('eth_simulateV1',[{
    blockStateCalls:[{ calls:[
      {from:OWNER,to:REG,data:grantData},
      {from:OWNER,to:REG,data:readData},
    ]}],
    traceTransfers:false, validation:false,
  },'latest']);
  const calls = res[0].calls;
  calls.forEach((c,i)=>console.log(`  call#${i} status=${c.status} gasUsed=${c.gasUsed} returnData=${c.returnData} err=${c.error?JSON.stringify(c.error):''}`));
  if (calls[1] && calls[1].status==='0x1')
    console.log('  DECODED isApprovedForPool AFTER grant =',
      decodeFunctionResult({abi:ABI,functionName:'isApprovedForPool',data:calls[1].returnData}));
} catch(e){ console.log('  eth_simulateV1 failed:', String(e.message).slice(0,300)); }

console.log('\n-- debug_traceCall stateDiff of the grant (shows SSTOREs) --');
for (const tracer of ['prestateTracer','callTracer']) {
  try {
    const t = await rpc('debug_traceCall',[{from:OWNER,to:REG,data:grantData},'latest',
      {tracer, tracerConfig: tracer==='prestateTracer'?{diffMode:true}:{}}]);
    console.log(`  ${tracer}:`, JSON.stringify(t).slice(0,1400));
  } catch(e){ console.log(`  ${tracer}: ${String(e.message).slice(0,150)}`); }
}
