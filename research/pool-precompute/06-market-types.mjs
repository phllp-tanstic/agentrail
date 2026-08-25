import { gql } from './rpc.mjs';
const d = await gql(`{ Market(distinct_on: marketType, limit: 50) { marketType } }`);
console.log('marketTypes:', d.Market.map(m=>m.marketType));
for (const mt of d.Market.map(m=>m.marketType)) {
  const q = await gql(`{ Market(where:{marketType:{_eq:"${mt}"}}, distinct_on: poolAddress, limit: 10000){ poolAddress } }`);
  const q2 = await gql(`{ Market(where:{marketType:{_eq:"${mt}"}}, distinct_on: binaryPoolAddress, limit: 10000){ binaryPoolAddress } }`);
  const q3 = await gql(`{ Market(where:{marketType:{_eq:"${mt}"}}, distinct_on: marketId, limit: 20000){ marketId } }`);
  console.log(`\n${mt}: markets=${q3.Market.length} distinctPool=${q.Market.length} distinctBinaryPool=${q2.Market.length}`);
  const s = await gql(`{ Market(where:{marketType:{_eq:"${mt}"}}, limit: 2){ marketId poolAddress binaryPoolAddress marketAddress asset intervalSec nonce clobStatus } }`);
  console.log('  sample:', JSON.stringify(s.Market, null, 1));
}
