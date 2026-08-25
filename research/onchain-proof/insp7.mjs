import { SomniaMarkets } from '@somnia-chain/markets-sdk';
import { TESTNET_CFG } from './config.mjs';
const ex = new SomniaMarkets(TESTNET_CFG);
const meths = o => { const s=new Set(); let p=o; while(p&&p!==Object.prototype){ for(const k of Object.getOwnPropertyNames(p)) s.add(k); p=Object.getPrototypeOf(p);} return [...s].sort(); };
console.log(meths(ex.client).filter(k=>/fill|trade|holder|portfolio|position|balance|owner/i.test(k)).join('\n'));
