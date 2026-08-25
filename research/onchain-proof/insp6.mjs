import { binarySettlementAbi, binaryModuleWriteAbi } from '@somnia-chain/markets-sdk';
for (const [n,abi] of Object.entries({binarySettlementAbi, binaryModuleWriteAbi})) {
  console.log('===', n, '===');
  for (const e of abi) {
    if (e.type==='function' && /redeem|claim|settl|sync/i.test(e.name))
      console.log(' ', `${e.name}(${e.inputs.map(i=>i.type+' '+i.name).join(', ')})`, '->', e.stateMutability);
  }
}
