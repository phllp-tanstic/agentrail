import { rpc, gql } from './rpc.mjs';
const d = await gql(`{ Market(where:{marketType:{_eq:"BINARY"}}, order_by:{createdAtBlock: desc}, limit:3){ marketId marketAddress poolAddress createdByTx nonce asset intervalSec } }`);
console.log('newest markets:', JSON.stringify(d.Market.map(m=>({id:m.marketId.slice(-6),mkt:m.marketAddress,pool:m.poolAddress,n:m.nonce,a:m.asset,iv:m.intervalSec})),null,1));
const tx = d.Market[0].createdByTx;
console.log('\ntracing', tx);
const t = await rpc('debug_traceTransaction',[tx,{tracer:'callTracer'}]);
const DEPLOYER='0x1a478019ae4d24249a962934af0f129ce98b5e6f';
let creates=[], depCalls=[];
(function walk(n, depth, path){
  const ty=(n.type||'').toUpperCase();
  if(ty==='CREATE'||ty==='CREATE2') creates.push({depth,type:ty,from:n.from,newAddr:n.to,inputLen:(n.input||'0x').length/2-1,path});
  if((n.from||'').toLowerCase()===DEPLOYER || (n.to||'').toLowerCase()===DEPLOYER)
    depCalls.push({depth,type:ty,from:n.from,to:n.to,sel:(n.input||'').slice(0,10),path});
  (n.calls||[]).forEach((c,i)=>walk(c,depth+1,path+'.'+i));
})(t,0,'0');
console.log('\nALL CREATE/CREATE2 frames in this tx:');
creates.forEach(c=>console.log(`  d${c.depth} ${c.type} from=${c.from} -> ${c.newAddr} initcodeLen=${c.inputLen}`));
if(!creates.length) console.log('  (none -- nothing deployed; pool AND market both pre-existing/allocated)');
console.log('\nframes touching deployer 0x1a478019:');
depCalls.slice(0,20).forEach(c=>console.log(`  d${c.depth} ${c.type} ${c.from} -> ${c.to} sel=${c.sel}`));
if(!depCalls.length) console.log('  (deployer NOT involved in this tx)');
// tally all frames by to-address+selector
const tally={};
(function w2(n){ const k=`${(n.to||'').slice(0,10)}..|${(n.input||'').slice(0,10)}`; tally[k]=(tally[k]||0)+1; (n.calls||[]).forEach(w2); })(t);
console.log('\ntop frames (to|selector => count):');
Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,14).forEach(([k,v])=>console.log('  ',k,v));
