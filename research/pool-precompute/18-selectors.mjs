import { rpc } from './rpc.mjs';
import { toFunctionSelector } from 'viem';
const sigs = [
 'placeBinaryOrderFor(address,uint8,uint256,uint256,uint64,uint8,uint8,address,uint96,uint64)',
 'placeBinaryOrder(uint8,uint256,uint256,uint64,uint8,uint8,address,uint96,uint64)',
 'placeOrderFor(address,bool,uint256,uint256,uint64,uint8,uint8,address,uint96,uint64)',
 'cancelOrder(uint128)',
 'cancelOrderFor(address,uint128)',
 'reduceOrder(uint128,uint256)',
 'reduceOrderFor(address,uint128,uint256)',
 'setOperatorApprovalForPool(address,address,bytes4[],bool)',
 'isApprovedForPool(address,address,address,bytes4)',
 'setOperatorApprovalGlobal(address,bytes4[],bool)',
 'multicall(bytes[])',
];
console.log('SELECTORS:');
const sel = {};
for (const s of sigs){ const x=toFunctionSelector('function '+s); sel[s]=x; console.log(`  ${x}  ${s}`); }
console.log('\nGROUND-TRUTH CLAIMS: placeOrderFor 0x80054449 | cancelOrderFor 0xe37b444b | reduceOrderFor 0x364c2587');
console.log(`  cancelOrderFor(address,uint128) => ${sel['cancelOrderFor(address,uint128)']} ${sel['cancelOrderFor(address,uint128)']==='0xe37b444b'?'MATCHES ground truth':'DIFFERS'}`);
console.log(`  reduceOrderFor(address,uint128,uint256) => ${sel['reduceOrderFor(address,uint128,uint256)']} ${sel['reduceOrderFor(address,uint128,uint256)']==='0x364c2587'?'MATCHES ground truth':'DIFFERS'}`);

// resolve the beacon -> pool implementation, then look for these selectors in its bytecode
const BEACON='0x85c01b5ef4f4ed59cac69749565e309f01b14dbc';
const impl = await rpc('eth_call',[{to:BEACON, data:'0x5c60da1b'}]);   // implementation()
const implAddr = '0x'+impl.slice(-40);
console.log('\nbeacon', BEACON, '-> pool implementation', implAddr);
const code = await rpc('eth_getCode',[implAddr,'latest']);
console.log('pool implementation codeLen', (code.length-2)/2);
console.log('\nselector presence in pool implementation bytecode (PUSH4 dispatch scan):');
const hay = code.toLowerCase();
for (const [s,x] of Object.entries(sel)) {
  const needle = '63'+x.slice(2);           // PUSH4 <sel>
  const bare = x.slice(2);
  console.log(`  ${x} ${hay.includes(needle)?'PRESENT(PUSH4)':(hay.includes(bare)?'present(raw bytes)':'ABSENT')}  ${s}`);
}
