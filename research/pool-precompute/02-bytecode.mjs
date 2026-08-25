import { rpc } from './rpc.mjs';
const POOLS = {
  'pool ETH/BTC 0x39b9': '0x39b910486dbc82510d0990caa8b4af05da864bb4',
  'pool 0xd229': '0xd22908ed947495d4d3dac8c75e75a5cf495ff736',
  'pool 0x363d': '0x363deb12f640de39b0575d158325dad098ba0d02',
  'pool 0x7539': '0x7539bfac347f92534462ef1f4dca3f1b8b1dc998',
  'mkt 0xe059(mkt)': '0xe05babe4813184a85f07f9763f12942be52a4c49',
  'creator-EOA 0xfe81': '0xfe81c4e8effb7df27eb21881f80af2bf8dcf0c39',
  'MarketCreator op5': '0xe207b1fa953b2e18ef46879555946cb5fa7ce74e',
  'MarketCreatorFactory': '0xe6bee93ce87c9e6e62acb621caa7832ee47b4f6b',
  'BinaryMarketsModule': '0x3ecc694cef705358864a646142ac17a90e29e388',
};
for (const [name, a] of Object.entries(POOLS)) {
  const code = await rpc('eth_getCode', [a, 'latest']);
  const len = (code.length - 2) / 2;
  console.log(`--- ${name}  ${a}  len=${len}`);
  if (len <= 400) console.log('    ', code);
}
