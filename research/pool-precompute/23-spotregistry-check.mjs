import { rpc } from './rpc.mjs';
import { encodeFunctionData, decodeFunctionResult, getContractAddress } from 'viem';
const SPOTREG='0xB601bc1099B040E4882089D94690F7C38AF4CCD2';
const ABI=[{name:'isRegistered',type:'function',stateMutability:'view',inputs:[{type:'address'}],outputs:[{type:'bool'}]}];
const HOT=['0x3a7be3355ca90e94efa38a7e86abe98ba5b98a75','0xa475e7cff65bd47c3a0783d071e7075e035048a8',
 '0x7539bfac347f92534462ef1f4dca3f1b8b1dc998','0x363deb12f640de39b0575d158325dad098ba0d02',
 '0xd22908ed947495d4d3dac8c75e75a5cf495ff736','0x39b910486dbc82510d0990caa8b4af05da864bb4',
 '0x68af9113c89acdbd0377f20b33b22ba8bf5e8eb3','0x843ca845bbad0db0954700264901de5e451940ae'];
const SPOTPOOL='0x47fd2f18426f67106dbac82f6d21d446c5f2120b';
console.log('SpotPoolRegistry.isRegistered() — premise check (binary pools should be FALSE):');
for(const p of [...HOT, SPOTPOOL]){
  const d=encodeFunctionData({abi:ABI,functionName:'isRegistered',args:[p]});
  try{ const r=await rpc('eth_call',[{to:SPOTREG,data:d},'latest']);
    const v=decodeFunctionResult({abi:ABI,functionName:'isRegistered',data:r});
    console.log(`  ${p} -> ${v}${p===SPOTPOOL?'   <-- known SPOT pool (control)':''}`); }
  catch(e){ console.log(`  ${p} -> revert ${String(e.message).slice(0,80)}`); }
}
// Also the registry's own isRegistered (0xc3c5a547) - which registry does it consult?
const REG='0xE7a190736B6024a4DbafadC04E283075877005ce';
console.log('\nemit the concrete grant target list');
import('node:fs').then(fs=>{
  const bank=JSON.parse(fs.readFileSync('pools-matched.json','utf8')).matched;
  const DEP='0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
  const fwd=[]; for(let n=850;n<850+480;n++) fwd.push({n,addr:getContractAddress({from:DEP,nonce:BigInt(n)})});
  fs.writeFileSync('GRANT-TARGETS.json', JSON.stringify({
    poolDeployer: DEP,
    hotPools: HOT,
    bank: bank.map(([addr,nonce])=>({addr,deployerNonce:nonce})),
    forwardWindow: fwd,
    selectorsForBinary: {placeBinaryOrderFor:'0x5d97c566', cancelOrderFor:'0xe37b444b', reduceOrderFor:'0x364c2587', placeOrderFor_legacy:'0x80054449'},
  },null,1));
  console.log('  wrote GRANT-TARGETS.json  (8 hot, '+bank.length+' bank, 480 forward slots)');
});
