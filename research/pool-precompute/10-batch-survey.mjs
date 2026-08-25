// Survey: batching primitives on Somnia mainnet (5031) + testnet (50312)
import { rpc, MAINNET, TESTNET } from './rpc.mjs';

const TARGETS = {
  'REGISTRY (mainnet)':            '0xE7a190736B6024a4DbafadC04E283075877005ce',
  'Multicall3 canonical':          '0xcA11bde05977b3631167028862bE2a173976CA11',
  'EntryPoint v0.6':               '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  'EntryPoint v0.7':               '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  'EntryPoint v0.8':               '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108',
  'Safe singleton 1.4.1':          '0x41675C099F32341bf84BFc5382aF534df5C7461a',
  'Safe singleton 1.3.0':          '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552',
  'SafeProxyFactory 1.4.1':        '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67',
  'SafeProxyFactory 1.3.0':        '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
  'CreateX':                       '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed',
  'Create2Deployer (Arachnid)':    '0x4e59b44847b379578588920cA78FbF26c0B4956C',
  'Permit2':                       '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  'MulticallV2 (uniswap)':         '0x5BA1e12693Dc8F9c48aAD8770482f4739bEeD696',
  'ERC-2470 SingletonFactory':     '0xce0042B868300000d44A59004Da54A005ffdcf9f',
};

for (const [net, url] of [['MAINNET', MAINNET], ['TESTNET', TESTNET]]) {
  console.log(`\n===== ${net} =====`);
  console.log('chainId', await rpc('eth_chainId', [], url));
  try { console.log('clientVersion', await rpc('web3_clientVersion', [], url)); } catch (e) { console.log('clientVersion ERR', e.message); }
  for (const [name, addr] of Object.entries(TARGETS)) {
    try {
      const code = await rpc('eth_getCode', [addr, 'latest'], url);
      const len = (code.length - 2) / 2;
      console.log(`  ${len === 0 ? 'EMPTY ' : 'CODE  '} ${String(len).padStart(6)} bytes  ${name.padEnd(28)} ${addr}`);
    } catch (e) { console.log(`  ERR    ${name} ${addr} ${e.message}`); }
  }
}
