// 1) Get the post-state SSTOREs from granting on an UNDEPLOYED pool.
// 2) Apply them as an eth_call stateOverride and prove isApprovedForPool == true.
import { rpc } from './rpc.mjs';
import { encodeFunctionData, decodeFunctionResult, getContractAddress, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
const REG='0xE7a190736B6024a4DbafadC04E283075877005ce';
const IMPL='0xefdbf940edcecda6e581ad561eceef735d46f248';
const OWNER='0x2222222222222222222222222222222222222222';
const OPERATOR='0x1111111111111111111111111111111111111111';
const SELS=['0x80054449','0xe37b444b','0x364c2587'];
const ABI=[
 {name:'setOperatorApprovalForPool',type:'function',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'bytes4[]'},{type:'bool'}],outputs:[]},
 {name:'isApprovedForPool',type:'function',stateMutability:'view',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'bytes4'}],outputs:[{type:'bool'}]},
];
const DEPLOYER='0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
const FUTURE = getContractAddress({from:DEPLOYER, nonce:830n});
const grant = encodeFunctionData({abi:ABI,functionName:'setOperatorApprovalForPool',args:[FUTURE,OPERATOR,SELS,true]});

const t = await rpc('debug_traceCall',[{from:OWNER,to:REG,data:grant,gas:'0x2000000'},'latest',{tracer:'prestateTracer',tracerConfig:{diffMode:true}}]);
const post = t.post || {};
const reg = post[REG.toLowerCase()] || {};
const wrote = reg.storage || {};
console.log('POST-state storage writes on registry:', Object.keys(wrote).length);
for (const [k,v] of Object.entries(wrote)) console.log('  ', k, '=', v);
console.log('\nother post-state accounts touched:', Object.keys(post).filter(a=>a!==REG.toLowerCase()));

// Also confirm: does the pool address even appear anywhere as a read? Compare vs a DIFFERENT pool
const grant2 = encodeFunctionData({abi:ABI,functionName:'setOperatorApprovalForPool',args:['0x000000000000000000000000000000000000dEaD',OPERATOR,SELS,true]});
const t2 = await rpc('debug_traceCall',[{from:OWNER,to:REG,data:grant2,gas:'0x2000000'},'latest',{tracer:'prestateTracer',tracerConfig:{diffMode:true}}]);
const wrote2 = (t2.post?.[REG.toLowerCase()]||{}).storage || {};
console.log('\nsame grant to 0x..dEaD writes slots:', Object.keys(wrote2).join(', '));
const overlap = Object.keys(wrote).filter(k=>k in wrote2);
console.log('slot overlap between the two pools:', overlap.length, '(0 => slots are pool-keyed, as expected)');

// --- state override read-back proof ---
const read = encodeFunctionData({abi:ABI,functionName:'isApprovedForPool',args:[FUTURE,OWNER,OPERATOR,SELS[0]]});
const before = await rpc('eth_call',[{from:OWNER,to:REG,data:read},'latest']);
console.log('\nisApprovedForPool BEFORE override =', decodeFunctionResult({abi:ABI,functionName:'isApprovedForPool',data:before}));
const ovr = { [REG]: { stateDiff: wrote } };
let after;
try {
  after = await rpc('eth_call',[{from:OWNER,to:REG,data:read},'latest',ovr]);
  console.log('isApprovedForPool AFTER  override =', decodeFunctionResult({abi:ABI,functionName:'isApprovedForPool',data:after}),
    '   <-- undeployed pool now authorized');
} catch(e){ console.log('stateOverride eth_call failed:', String(e.message).slice(0,250)); }
