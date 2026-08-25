import { rpc } from './rpc.mjs';
const REG='0xE7a190736B6024a4DbafadC04E283075877005ce';
const r = await fetch(`https://explorer.somnia.network/api/v2/addresses/${REG}/transactions?filter=to`).then(r=>r.json()).catch(e=>({items:[]}));
const items=r.items||[];
console.log('txs TO OperatorPermissionsRegistry:', items.length);
const bySel={};
for(const it of items){ const s=(it.raw_input||'').slice(0,10); bySel[s]=(bySel[s]||0)+1; }
console.log('by selector:', JSON.stringify(bySel));
for(const it of items.slice(0,6)) console.log(`  ${it.hash} sel=${(it.raw_input||'').slice(0,10)} from=${(it.from||{}).hash} status=${it.status}`);

// decode a real setOperatorApprovalForPool call if present
const g = items.find(it=>(it.raw_input||'').startsWith('0x7bbc67e6'));
if(g){
  console.log('\nREAL per-pool grant found:', g.hash);
  const inp=g.raw_input;
  const pool='0x'+inp.slice(10+24,10+64);
  const op='0x'+inp.slice(10+64+24,10+128);
  console.log('  pool =',pool,' operator =',op, ' owner(from) =',(g.from||{}).hash);
  const ABI=[{name:'isApprovedForPool',type:'function',stateMutability:'view',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'bytes4'}],outputs:[{type:'bool'}]}];
  const { encodeFunctionData, decodeFunctionResult } = await import('viem');
  for(const sel of ['0x80054449','0x5d97c566','0xe37b444b','0x364c2587']){
    const d=encodeFunctionData({abi:ABI,functionName:'isApprovedForPool',args:[pool,(g.from||{}).hash,op,sel]});
    try{ const res=await rpc('eth_call',[{to:REG,data:d},'latest']);
      console.log(`   isApprovedForPool(sel=${sel}) = ${decodeFunctionResult({abi:ABI,functionName:'isApprovedForPool',data:res})}`); }
    catch(e){ console.log(`   sel=${sel} revert`); }
  }
} else console.log('\n(no 0x7bbc67e6 per-pool grant tx in the first page of registry txs)');

console.log('\n=== forward-window sizing ===');
const DEP='0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
const n=parseInt(await rpc('eth_getTransactionCount',[DEP,'latest']),16);
console.log('  pool-deployer nonce now =', n, ' (burn ~235-240/day from CREATE2 market clones)');
console.log('  to cover D days of possible new-pool deploys you must pre-grant ~240*D CREATE slots:');
for(const D of [1,7,30]) console.log(`    ${String(D).padStart(2)} days -> ${240*D} addresses  (${(240*D*2.22).toFixed(0)}M gas @2.22M each; block limit 15,000M)`);
