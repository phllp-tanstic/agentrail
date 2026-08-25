// Does the OperatorPermissionsRegistry have an existence guard on `pool`?
import { rpc } from './rpc.mjs';
import { encodeFunctionData, getContractAddress } from 'viem';
const REG = '0xE7a190736B6024a4DbafadC04E283075877005ce';
const OPERATOR = '0x1111111111111111111111111111111111111111'; // fake session key
const OWNER    = '0x2222222222222222222222222222222222222222'; // fake user (from)
const SELS = ['0x80054449','0xe37b444b','0x364c2587'];
const ABI = [
 {name:'setOperatorApprovalForPool',type:'function',stateMutability:'nonpayable',
  inputs:[{name:'pool',type:'address'},{name:'operator',type:'address'},{name:'selectors',type:'bytes4[]'},{name:'approved',type:'bool'}],outputs:[]},
 {name:'isApprovedForPool',type:'function',stateMutability:'view',
  inputs:[{name:'pool',type:'address'},{name:'owner',type:'address'},{name:'operator',type:'address'},{name:'selector',type:'bytes4'}],outputs:[{type:'bool'}]},
];
const code = await rpc('eth_getCode',[REG,'latest']);
console.log('registry codeLen', (code.length-2)/2);
const implSlot = await rpc('eth_getStorageAt',[REG,'0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc','latest']);
console.log('EIP1967 impl slot:', implSlot);
// how many EXTCODESIZE (0x3b) opcodes appear? crude but indicative
const body = code.slice(2);
let ecs=0; for(let i=0;i<body.length-1;i+=2) if(body.slice(i,i+2)==='3b') ecs++;
console.log('raw 0x3b byte occurrences (EXTCODESIZE, crude):', ecs);

const DEPLOYER='0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
const FUTURE = [830, 832, 900, 1000].map(n=>({n, a:getContractAddress({from:DEPLOYER,nonce:BigInt(n)})}));
const EXISTING = '0x39b910486dbc82510d0990caa8b4af05da864bb4';
const RANDOM_EOA = '0x000000000000000000000000000000000000dEaD';

async function tryGrant(pool, label) {
  const data = encodeFunctionData({abi:ABI, functionName:'setOperatorApprovalForPool', args:[pool, OPERATOR, SELS, true]});
  try {
    const r = await rpc('eth_call',[{from:OWNER, to:REG, data}, 'latest']);
    console.log(`  OK      ${label}  pool=${pool}  ret=${r}`);
    return true;
  } catch(e) {
    console.log(`  REVERT  ${label}  pool=${pool}  ${String(e.message).slice(0,220)}`);
    return false;
  }
}
console.log('\n--- eth_call setOperatorApprovalForPool (from = fake owner, no key needed) ---');
await tryGrant(EXISTING, 'EXISTING deployed pool');
for (const f of FUTURE) await tryGrant(f.a, `UNDEPLOYED CREATE(deployer,${f.n})`);
await tryGrant(RANDOM_EOA, 'random non-contract 0x..dEaD');
await tryGrant('0x0000000000000000000000000000000000000000', 'zero address');
