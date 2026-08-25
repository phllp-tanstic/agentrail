import { rpc, gql } from './rpc.mjs';
import { getContractAddress, getCreate2Address, keccak256, concat, pad, toHex, encodeAbiParameters, parseAbiParameters } from 'viem';
const DEPLOYER='0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
const IH='0x13139331e858dd5806b27206b27def2d45565a153c255f3d5f984354be3c0bd2';

console.log('=== (1) market clones: alive but NOT at any CREATE nonce slot => CREATE2 ===');
for(const m of ['0x617ec708ff353316ce44268e2132a4eab6377850','0xee1a3da759a800d27e86209779fc27bb92d20ec0']){
  const c=await rpc('eth_getCode',[m,'latest']);
  console.log(`  ${m} codeLen=${(c.length-2)/2} alive=${c!=='0x'}`);
}
const nonceNow = parseInt(await rpc('eth_getTransactionCount',[DEPLOYER,'latest']),16);
let occupied=0; for(let n=0;n<=nonceNow;n+=1){ }
console.log(`  deployer nonce=${nonceNow}; nonce slots holding code (from earlier scan of 0..900) = 134`);
console.log(`  => ${nonceNow-134} nonces consumed with NO nonce-derived contract  ==> CREATE2 deploys`);

console.log('\n=== (2) brute-force market CREATE2 salt (broader candidate set) ===');
const s = await gql(`{ Market(where:{marketType:{_eq:"BINARY"}}, order_by:{createdAtBlock: desc}, limit:2){ marketId marketAddress poolAddress nonce asset expiry tradingStart intervalSec operatorId venueId } }`);
for(const m of s.Market){
  const cands = {};
  cands['marketId'] = m.marketId;
  cands['keccak(marketId)'] = keccak256(m.marketId);
  cands['pad(pool)'] = pad(m.poolAddress,{size:32});
  cands['keccak(pool||nonce u256)'] = keccak256(encodeAbiParameters(parseAbiParameters('address,uint256'),[m.poolAddress,BigInt(m.nonce)]));
  cands['keccak(pool||nonce u96)'] = keccak256(concat([m.poolAddress, pad(toHex(BigInt(m.nonce)),{size:12})]));
  cands['pool||nonce packed(bytes32)'] = concat([m.poolAddress, pad(toHex(BigInt(m.nonce)),{size:12})]);
  cands['keccak(venue||marketId)'] = keccak256(concat([m.venueId, m.marketId]));
  cands['keccak(expiry)'] = keccak256(pad(toHex(BigInt(m.expiry)),{size:32}));
  let hit=null;
  for(const [k,salt] of Object.entries(cands)){
    try{ if(getCreate2Address({from:DEPLOYER,salt,bytecodeHash:IH}).toLowerCase()===m.marketAddress.toLowerCase()){hit=k;break;} }catch(e){}
  }
  console.log(`  ${m.marketAddress} salt=${hit||'none of '+Object.keys(cands).length+' candidates'}`);
}

console.log('\n=== (3) OLD generation pools: different deployer? (architecture churn risk) ===');
const old = await gql(`{ Market(where:{marketType:{_eq:"BINARY"}}, order_by:{createdAtBlock: asc}, limit:3){ poolAddress createdAtBlock marketId } }`);
for(const m of old.Market){
  const r = await fetch(`https://explorer.somnia.network/api/v2/addresses/${m.poolAddress}`).then(r=>r.json()).catch(()=>({}));
  const c = await rpc('eth_getCode',[m.poolAddress,'latest']);
  console.log(`  ${m.poolAddress} blk=${m.createdAtBlock} codeLen=${(c.length-2)/2} creator=${r.creator_address_hash||'?'}`);
}

console.log('\n=== (4) do any REAL per-pool grants exist on-chain today? (read path sanity) ===');
const ABI=[{name:'isApprovedForPool',type:'function',stateMutability:'view',inputs:[{type:'address'},{type:'address'},{type:'address'},{type:'bytes4'}],outputs:[{type:'bool'}]}];
const REG='0xE7a190736B6024a4DbafadC04E283075877005ce';
const rc = await rpc('eth_getCode',[REG,'latest']);
console.log('  registry proxy codeLen', (rc.length-2)/2, '-> impl 0xefdbf940edcecda6e581ad561eceef735d46f248');
const ic = await rpc('eth_getCode',['0xefdbf940edcecda6e581ad561eceef735d46f248','latest']);
console.log('  impl codeLen', (ic.length-2)/2);
// count 3b (EXTCODESIZE) in impl
const body=ic.slice(2); let n3b=0; for(let i=0;i<body.length-1;i+=2) if(body.slice(i,i+2)==='3b') n3b++;
console.log('  impl: crude 0x3b(EXTCODESIZE) byte count =', n3b);
