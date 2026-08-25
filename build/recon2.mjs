// PHASE A RECON 2: owner wallet state, client method surface, order-book/quote helpers.
import * as SDK from '@somnia-chain/markets-sdk';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = 'https://api.infra.testnet.somnia.network';
const INDEXER = 'https://dev.smk.somnia.host/v1/graphql';
const A = SDK.SOMNIA_TESTNET_ADDRESSES;
const owner = privateKeyToAccount(process.env.AGENTRAIL_OWNER_KEY);
console.log('OWNER ADDRESS (public):', owner.address);

const ex = new SDK.SomniaMarkets({ chain: somniaShannon, rpcUrl: RPC, indexerUrl: INDEXER, addresses: A });
console.log('\n=== ex.client own keys ===');
console.log(Object.keys(ex.client).filter(k => typeof ex.client[k] === 'function').join('\n'));
console.log('\n=== ex own keys ===');
console.log(Object.keys(ex).join(','));

const pc = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
const COLL = A.collateral;
console.log('\n=== OWNER WALLET STATE (testnet) ===');
const somi = await pc.getBalance({ address: owner.address });
console.log('native SOMI :', formatUnits(somi, 18), `(raw ${somi})`);
const dec = await pc.readContract({ address: COLL, abi: erc20Abi, functionName: 'decimals' });
const sym = await pc.readContract({ address: COLL, abi: erc20Abi, functionName: 'symbol' });
const bal = await pc.readContract({ address: COLL, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
console.log(`collateral  : ${COLL} (${sym}, ${dec} dec)`);
console.log('  balance   :', formatUnits(bal, dec), `(raw ${bal})`);
for (const [label, spender] of [['binaryModule', A.binaryModule], ['collateralRouter', A.collateralRouter],
                                ['binarySettlement', A.binarySettlement], ['marketsCore', A.marketsCore]]) {
  const al = await pc.readContract({ address: COLL, abi: erc20Abi, functionName: 'allowance', args: [owner.address, spender] });
  console.log(`  allowance -> ${label} ${spender}: ${al}`);
}

// pick the market with the LONGEST runway among the short ones, to inspect quote helpers
const live = await ex.client.listLiveBinaryMarkets();
const now = Math.floor(Date.now() / 1000);
const sorted = live.map(m => ({ m, t: Number(m.expiry) - now })).sort((a, b) => a.t - b.t);
const pick = sorted.find(x => x.t > 90) ?? sorted[sorted.length - 1];
const m = pick.m;
console.log(`\n=== chosen for inspection: ${m.marketId} ${m.asset} pool=${m.poolAddress} T-${pick.t}s ===`);
console.log('operatorId:', m.operatorId, 'venueId:', m.venueId, 'intervalSec:', m.intervalSec,
            'yesTokenId:', m.yesTokenId, 'noTokenId:', m.noTokenId);
console.log('allowance -> POOL:', await pc.readContract({ address: COLL, abi: erc20Abi, functionName: 'allowance', args: [owner.address, m.poolAddress] }));
console.log('book params:', JSON.stringify(await ex.client.getBinaryBookParams(m.poolAddress), (k, v) => typeof v === 'bigint' ? v.toString() : v));

console.log('\n=== order book probes ===');
for (const fn of ['getBinaryOrderBook', 'fetchOrderBook', 'getOrderBook', 'getBinaryBook', 'getBook']) {
  if (typeof ex.client[fn] !== 'function') { console.log(fn, '-> not a function'); continue; }
  try {
    const ob = await ex.client[fn](m.poolAddress);
    console.log(fn, '->', JSON.stringify(ob, (k, v) => typeof v === 'bigint' ? v.toString() : v).slice(0, 1200));
  } catch (e) { console.log(fn, 'ERR:', e.shortMessage || e.message); }
}

console.log('\n=== ERC6909 outcome-token balance read ===');
const OT = await pc.readContract({ address: A.binarySettlement, abi: SDK.binarySettlementAbi, functionName: 'outcomeToken' }).catch(e => 'ERR ' + e.shortMessage);
console.log('outcomeToken():', OT);
if (typeof OT === 'string' && OT.startsWith('0x')) {
  const b = await pc.readContract({ address: OT, abi: SDK.erc6909Abi, functionName: 'balanceOf', args: [owner.address, BigInt(m.yesTokenId)] }).catch(e => 'ERR ' + (e.shortMessage || e.message));
  console.log('erc6909 balanceOf(owner, yesTokenId):', b);
}
console.log('\nisPoolApproved(pool):', await pc.readContract({ address: A.binarySettlement, abi: SDK.binarySettlementAbi, functionName: 'isPoolApproved', args: [m.poolAddress] }).catch(e => 'ERR ' + e.shortMessage));
console.log('ORDER_TYPE:', JSON.stringify(SDK.ORDER_TYPE), 'ORDER_KIND:', JSON.stringify(SDK.ORDER_KIND));
console.log('ORDER_KIND_SIDE:', JSON.stringify(SDK.ORDER_KIND_SIDE), 'SELF_MATCHING_OPTION:', JSON.stringify(SDK.SELF_MATCHING_OPTION));
process.exit(0);
