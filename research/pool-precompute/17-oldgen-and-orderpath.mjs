import { rpc, gql } from './rpc.mjs';
import { getContractAddress } from 'viem';
console.log('=== OLD-GEN deployer 0xb2BE8EE02F96379DB75f01802384593EBa9bfF04: same plain-CREATE mechanism? ===');
const OLD='0xb2BE8EE02F96379DB75f01802384593EBa9bfF04';
const nOld = parseInt(await rpc('eth_getTransactionCount',[OLD,'latest']),16);
console.log('  old deployer nonce =', nOld);
const map=new Map(); for(let n=0;n<=Math.min(nOld+50,20000);n++) map.set(getContractAddress({from:OLD,nonce:BigInt(n)}).toLowerCase(),n);
const d = await gql(`{ Market(where:{marketType:{_eq:"BINARY"}}, order_by:{createdAtBlock: asc}, limit:12){ poolAddress createdAtBlock } }`);
let hit=0;
for(const m of d.Market){ const n=map.get(m.poolAddress.toLowerCase()); if(n!==undefined)hit++;
  console.log(`  ${m.poolAddress} -> CREATE nonce ${n??'NOT FOUND'}`); }
console.log(`  old-gen pools matching CREATE(oldDeployer,n): ${hit}/${d.Market.length}`);

console.log('\n=== ORDER PATH: is the operator registry consulted with the POOL address? ===');
// find a recent tx that touches a hot pool with a non-view call
const HOT='0x39b910486dbc82510d0990caa8b4af05da864bb4';
const r = await fetch(`https://explorer.somnia.network/api/v2/addresses/${HOT}/transactions?filter=to`).then(r=>r.json()).catch(()=>({items:[]}));
const items=(r.items||[]).slice(0,6);
console.log('  recent txs TO the hot pool:', items.length);
for(const it of items.slice(0,3)) console.log('   ', it.hash, 'method', it.method, 'sel', (it.raw_input||'').slice(0,10), 'from', (it.from||{}).hash);
// trace one and look for OperatorPermissionsRegistry involvement
const REG='0xe7a190736b6024a4dbafadc04e283075877005ce';
for(const it of items.slice(0,3)){
  try{
    const t = await rpc('debug_traceTransaction',[it.hash,{tracer:'callTracer'}]);
    const found=[];
    (function w(n){ if((n.to||'').toLowerCase()===REG) found.push({type:n.type,from:n.from,sel:(n.input||'').slice(0,10),input:(n.input||'').slice(0,266)}); (n.calls||[]).forEach(w); })(t);
    console.log(`  tx ${it.hash.slice(0,14)} sel=${(it.raw_input||'').slice(0,10)} -> registry frames: ${found.length}`);
    found.slice(0,2).forEach(f=>console.log('      ',f.type,'sel',f.sel,'\n       input',f.input));
  }catch(e){ console.log('   trace fail', String(e.message).slice(0,90)); }
}
console.log('\n=== gas estimate for one setOperatorApprovalForPool (3 selectors) ===');
const { encodeFunctionData } = await import('viem');
const ABI=[{name:'setOperatorApprovalForPool',type:'function',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'address'},{type:'bytes4[]'},{type:'bool'}],outputs:[]}];
const data=encodeFunctionData({abi:ABI,functionName:'setOperatorApprovalForPool',args:[getContractAddress({from:'0x1a478019Ae4d24249a962934af0f129CE98B5e6f',nonce:830n}),'0x1111111111111111111111111111111111111111',['0x80054449','0xe37b444b','0x364c2587'],true]});
try{ const g=await rpc('eth_estimateGas',[{from:'0x2222222222222222222222222222222222222222',to:'0xE7a190736B6024a4DbafadC04E283075877005ce',data}]);
  console.log('  eth_estimateGas =', parseInt(g,16), 'gas'); }catch(e){ console.log('  estimateGas:', String(e.message).slice(0,180)); }
