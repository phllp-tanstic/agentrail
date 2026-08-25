import { toFunctionSelector } from 'viem';
const HAVE = new Set(['0x03684f95','0x3a0afa7f','0x4381b341','0x443635a3','0x485cc955','0x4f1ef286','0x52d1902d','0x715018a6','0x79ba5097','0x7bbc67e6','0x7f1e31ce','0x8da5cb5b','0xad3cb1cc','0xaf1e64a8','0xccb0797d','0xcdf7260d','0xe30c3978','0xf2fde38b','0xccea9e6f','0x019daeeb','0x2570a0d9','0xf92ee8a9','0x21eed1cd','0x118cdaa7','0xc3c5a547','0x703e46dd','0x4c9c8ce3','0x2a875269','0x1afcd79f','0x1e4fbdf7','0x9996b315','0xd6bda275','0xb398979f']);
const guesses = [
 'setOperatorApprovalForPools(address[],address,bytes4[],bool)',
 'setOperatorApprovalForPools(address[],address,bytes4[],bool[])',
 'setOperatorApprovalForPoolBatch(address[],address,bytes4[],bool)',
 'setOperatorApprovalForPoolsBatch(address[],address,bytes4[],bool)',
 'batchSetOperatorApprovalForPool(address[],address,bytes4[],bool)',
 'setOperatorApprovalForPool(address[],address,bytes4[],bool)',
 'setOperatorApprovalsForPools(address[],address,bytes4[],bool)',
 'multicall(bytes[])','tryMulticall(bytes[])','multicallWithValue(bytes[],uint256[])',
 'isApprovedForPoolBatch(address[],address,address,bytes4)',
 'isApprovedForPools(address[],address,address,bytes4)',
 'isApprovedForPoolMulti(address,address,address,bytes4[])',
 'setOperatorApprovalDenyForPool(address,address,bytes4[],bool)',
 'setPerPoolDenied(address,address,bytes4[],bool)',
 'setOperatorApprovalGlobal(address,bytes4[],bool)',
 'isGloballyApproved(address,address,bytes4)',
 'isApproved(address,address,address,bytes4)',
 'poolRegistry()','spotPoolRegistry()','setSpotPoolRegistry(address)',
 'UPGRADE_INTERFACE_VERSION()','proxiableUUID()','owner()','initialize(address)','initialize(address,address)',
 'renounceOwnership()','transferOwnership(address)','acceptOwnership()','pendingOwner()','upgradeToAndCall(address,bytes)',
 'isApprovedForPoolWithReason(address,address,address,bytes4)',
 'getPoolApproval(address,address,address,bytes4)',
 'operatorApprovalForPool(address,address,address,bytes4)',
 'setOperatorApprovalForPoolWithExpiry(address,address,bytes4[],bool,uint64)',
 'setOperatorApprovalForPoolFor(address,address,address,bytes4[],bool)',
 'setOperatorApprovalForPoolBySig(address,address,address,bytes4[],bool,uint256,bytes)',
 'setOperatorApprovalForPoolWithSig(address,address,bytes4[],bool,uint256,bytes)',
 'nonces(address)','DOMAIN_SEPARATOR()','eip712Domain()',
];
console.log('signature -> selector  [PRESENT on registry impl?]');
const found=[];
for(const g of guesses){ const s=toFunctionSelector('function '+g); const p=HAVE.has(s);
  if(p) found.push([s,g]);
  console.log(`  ${s}  ${p?'*** PRESENT ***':'absent      '}  ${g}`); }
console.log('\nMATCHED registry functions:'); found.forEach(([s,g])=>console.log('  ',s,g));
const unresolved=[...HAVE].filter(s=>!found.some(f=>f[0]===s));
console.log('\nSTILL-UNRESOLVED registry selectors:', unresolved.join(' '));
console.log('\n-- 4byte lookup for unresolved --');
for(const s of unresolved){
  try{ const r=await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${s}`).then(r=>r.json());
    const n=(r.results||[]).map(x=>x.text_signature);
    console.log(`  ${s}: ${n.length?n.slice(0,3).join(' | '):'(unknown)'}`); }catch(e){ console.log(`  ${s}: lookup failed`); }
}
