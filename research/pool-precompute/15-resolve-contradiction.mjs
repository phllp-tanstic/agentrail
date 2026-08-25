import { rpc } from './rpc.mjs';
import { getContractAddress } from 'viem';
const DEPLOYER='0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
const MKTS=['0x617ec708ff353316ce44268e2132a4eab6377850','0xee1a3da759a800d27e86209779fc27bb92d20ec0',
            '0x1cfccd0b9edb7cb218b3873993e34853fb984942','0x4a67576c5e5127091358f8842bbbae32a87b21ec'];
const map=new Map();
for(let n=0;n<=3000;n++) map.set(getContractAddress({from:DEPLOYER,nonce:BigInt(n)}).toLowerCase(),n);
console.log('scan CREATE(0x1a478019, n) n=0..3000 for the 4 market clones from the trace:');
for(const m of MKTS) console.log('  ',m,'-> nonce',map.get(m)??'NOT FOUND');
console.log('\ndeployer nonce now:', parseInt(await rpc('eth_getTransactionCount',[DEPLOYER,'latest']),16));
// recheck codes right around current nonce
console.log('\ncode at CREATE(deployer,n) for n near head:');
for(const n of [830,834,838,840,841,842,845,850]){
  const a=getContractAddress({from:DEPLOYER,nonce:BigInt(n)});
  const c=await rpc('eth_getCode',[a,'latest']);
  console.log(`  n=${n} ${a} len=${(c.length-2)/2} ${c.slice(0,24)}`);
}
// pull the ACTUAL initcode + true creator from the trace
const t = await rpc('debug_traceTransaction',['0x5c99786a4323a7d4446665c0cbd07883f874f6d345d1bbb21571db99aff8c447',{tracer:'callTracer'}]);
(function w(n,d,path){ const ty=(n.type||'').toUpperCase();
  if(ty==='CREATE'||ty==='CREATE2') console.log(`\nCREATE frame path=${path} depth=${d} from=${n.from} to=${n.to}\n  initcode=${n.input}`);
  (n.calls||[]).forEach((c,i)=>w(c,d+1,path+'.'+i)); })(t,0,'0');
// print the ancestor chain of the first CREATE to see if 0x1a478019 was DELEGATECALLed into
function findChain(node, target, chain){
  const c2=[...chain,{type:node.type,from:node.from,to:node.to}];
  if(((node.type||'').toUpperCase().startsWith('CREATE')) && (node.to||'').toLowerCase()===target) return c2;
  for(const c of node.calls||[]){ const r=findChain(c,target,c2); if(r) return r; }
  return null;
}
const chain=findChain(t, MKTS[0].toLowerCase(), []);
console.log('\nANCESTOR CHAIN to the CREATE of', MKTS[0]);
chain?.forEach((f,i)=>console.log(`  [${i}] ${f.type} ${f.from} -> ${f.to}`));
