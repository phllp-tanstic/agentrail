// PHASE A RECON (read-only): SDK surface + owner wallet state on testnet.
// Never prints the private key. Prints the derived ADDRESS only (public).
import * as SDK from '@somnia-chain/markets-sdk';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import { createPublicClient, http, encodeFunctionData, erc20Abi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = 'https://api.infra.testnet.somnia.network';
const INDEXER = 'https://dev.smk.somnia.host/v1/graphql';

const KEY = process.env.AGENTRAIL_OWNER_KEY;
if (!KEY) { console.log('FATAL: AGENTRAIL_OWNER_KEY not in env'); process.exit(1); }
const owner = privateKeyToAccount(KEY);
console.log('OWNER ADDRESS (public):', owner.address);

console.log('\n=== SDK exports of interest ===');
const names = Object.keys(SDK);
const want = /binary|redeem|abi|ADDRESS|SELECTOR|ORDER|SIDE|KIND|SELF_MATCH|ZERO/i;
console.log(names.filter(n => want.test(n)).join('\n'));

console.log('\n=== SOMNIA_TESTNET_ADDRESSES ===');
console.log(JSON.stringify(SDK.SOMNIA_TESTNET_ADDRESSES, null, 2));

console.log('\n=== client method names ===');
const ex = new SDK.SomniaMarkets({
  chain: somniaShannon, rpcUrl: RPC, indexerUrl: INDEXER,
  addresses: SDK.SOMNIA_TESTNET_ADDRESSES,
});
const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(ex.client));
console.log(proto.filter(n => n !== 'constructor').join('\n'));

console.log('\n=== ABI function lists ===');
for (const a of ['binaryPoolWriteAbi', 'binaryModuleWriteAbi', 'binarySettlementAbi', 'binaryPoolReadAbi']) {
  if (!SDK[a]) { console.log(a, '-> ABSENT'); continue; }
  const fns = SDK[a].filter(x => x.type === 'function')
    .map(x => `${x.name}(${x.inputs.map(i => i.type).join(',')})`);
  console.log(`\n${a}:\n  ` + fns.join('\n  '));
}

console.log('\n=== LIVE BINARY MARKETS (testnet) ===');
const live = await ex.client.listLiveBinaryMarkets();
console.log('count:', live.length);
const now = Math.floor(Date.now() / 1000);
const rows = live.map(m => ({
  marketId: m.marketId, pool: m.poolAddress, asset: m.asset, status: m.status,
  expiry: m.expiry, secsToExpiry: Number(m.expiry) - now, quoteDecimals: m.quoteDecimals,
})).sort((a, b) => a.secsToExpiry - b.secsToExpiry);
console.log(JSON.stringify(rows.slice(0, 12), null, 2));
if (rows[0]) {
  console.log('\nfull market object keys:', Object.keys(live[0]).join(','));
  console.log(JSON.stringify(live.find(m => m.marketId === rows[0].marketId),
    (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

console.log('\n=== OWNER WALLET STATE ===');
const pc = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
const somi = await pc.getBalance({ address: owner.address });
console.log('native SOMI balance:', formatUnits(somi, 18), `(raw ${somi})`);

// collateral token: find it from the market / SDK addresses
const cand = SDK.SOMNIA_TESTNET_ADDRESSES;
console.log('\ncollateral candidates from SDK addresses:',
  JSON.stringify(Object.entries(cand).filter(([k]) => /usd|collateral|quote|token/i.test(k))));

const target = live.find(m => m.marketId === rows[0]?.marketId);
if (target) {
  const quote = target.quoteToken ?? target.collateral ?? target.quoteTokenAddress ?? cand.usdso ?? null;
  console.log('resolved quote token:', quote);
  if (quote) {
    for (const fn of ['decimals', 'symbol']) {
      try { console.log(` ${fn}:`, await pc.readContract({ address: quote, abi: erc20Abi, functionName: fn })); }
      catch (e) { console.log(` ${fn} ERR`, e.shortMessage || e.message); }
    }
    const bal = await pc.readContract({ address: quote, abi: erc20Abi, functionName: 'balanceOf', args: [owner.address] });
    console.log(' owner collateral balance raw:', bal);
    const allowPool = await pc.readContract({ address: quote, abi: erc20Abi, functionName: 'allowance', args: [owner.address, target.poolAddress] });
    console.log(' allowance -> pool:', allowPool);
    const allowMod = await pc.readContract({ address: quote, abi: erc20Abi, functionName: 'allowance', args: [owner.address, cand.binaryModule] });
    console.log(' allowance -> binaryModule:', allowMod);
  }
  console.log('\nbook params:', JSON.stringify(await ex.client.getBinaryBookParams(target.poolAddress),
    (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  console.log('\ngetMarketOnchain:', JSON.stringify(await ex.client.getMarketOnchain(target.marketId),
    (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  try {
    const ob = await ex.client.getBinaryOrderBook?.(target.poolAddress)
      ?? await ex.client.fetchOrderBook?.(target.poolAddress);
    console.log('\norder book:', JSON.stringify(ob, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2).slice(0, 1500));
  } catch (e) { console.log('\norder book ERR:', e.shortMessage || e.message); }
}
process.exit(0);
