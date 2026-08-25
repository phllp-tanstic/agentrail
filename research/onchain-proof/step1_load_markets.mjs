// STEP 1: Instantiate SomniaMarkets vs testnet, list binary markets, pick a live Trading one.
// READ-ONLY. No private key required.
import { SomniaMarkets, isBinaryMarket, PLACE_ORDER_FOR_SELECTOR, CANCEL_ORDER_FOR_SELECTOR,
         SOMNIA_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk';
import { TESTNET_CFG } from './config.mjs';
import fs from 'node:fs';

console.log('PLACE_ORDER_FOR_SELECTOR  =', PLACE_ORDER_FOR_SELECTOR,  '(ground truth 0x80054449)');
console.log('CANCEL_ORDER_FOR_SELECTOR =', CANCEL_ORDER_FOR_SELECTOR, '(ground truth 0xe37b444b)');
console.log('SOMNIA_TESTNET_ADDRESSES keys =', Object.keys(SOMNIA_TESTNET_ADDRESSES).join(','));
console.log('  -> operatorPermissionsRegistry present?',
            'operatorPermissionsRegistry' in SOMNIA_TESTNET_ADDRESSES);

const ex = new SomniaMarkets(TESTNET_CFG);
console.log('SomniaMarkets instantiated OK. client =', !!ex.client);

const live = await ex.client.listLiveBinaryMarkets()
  .catch(e => { console.log('listLiveBinaryMarkets ERR:', e.message); return []; });
console.log('listLiveBinaryMarkets() ->', live.length, 'markets');

const all = await ex.client.listBinaryMarkets({ limit: 200 })
  .catch(e => { console.log('listBinaryMarkets ERR:', e.message); return []; });
console.log('listBinaryMarkets({limit:200}) ->', all.length, 'markets');

const hist = {};
for (const m of [...all, ...live]) hist[String(m.status)] = (hist[String(m.status)] || 0) + 1;
console.log('status histogram (all+live):', JSON.stringify(hist));

const src = live.length ? live : all;
if (src[0]) console.log('market object keys:', Object.keys(src[0]).join(','));

const bins = src.filter(m => isBinaryMarket(m));
console.log('isBinaryMarket() true for', bins.length, '/', src.length);

const trading = bins.filter(m => m.status === 'Trading' || m.status === 1);
console.log('Trading-status binary markets:', trading.length);

const chosen = trading[0] ?? bins[0];
if (!chosen) { console.log('NO BINARY MARKET FOUND -> STEP 1 cannot pick a market'); process.exit(1); }

const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
console.log('\n=== CHOSEN MARKET ===');
console.log(J(chosen).slice(0, 2500));
fs.writeFileSync('chosen-market.json', J(chosen));
console.log('\n-> wrote chosen-market.json');
process.exit(0);
