const sdk = await import('@somnia-chain/markets-sdk');
const ks = Object.keys(sdk);
console.log('TOTAL EXPORTS:', ks.length);
const want = /market|binary|redeem|address|tick|operator|client|list/i;
console.log(ks.filter(k=>want.test(k)).join('\n'));
console.log('\n--- chains ---');
const ch = await import('@somnia-chain/markets-sdk/chains');
console.log(Object.keys(ch).join(', '));
if (ch.somniaShannon) console.log('somniaShannon:', JSON.stringify({id:ch.somniaShannon.id, name:ch.somniaShannon.name, rpc:ch.somniaShannon.rpcUrls}));
