// Decisive test: are pools deployed via plain CREATE from 0x1a478019...?
// CREATE address = keccak(rlp([deployer, nonce]))[12:]
import { getContractAddress } from 'viem';
const DEPLOYER = '0x1a478019Ae4d24249a962934af0f129CE98B5e6f';
const KNOWN = {
  '0x39b910486dbc82510d0990caa8b4af05da864bb4': 'pool ETH/BTC (nonce29-31)',
  '0xd22908ed947495d4d3dac8c75e75a5cf495ff736': 'pool (nonce29-30)',
  '0x363deb12f640de39b0575d158325dad098ba0d02': 'pool (nonce16)',
  '0x7539bfac347f92534462ef1f4dca3f1b8b1dc998': 'pool (nonce16)',
  '0xe05babe4813184a85f07f9763f12942be52a4c49': 'marketAddress #1',
  '0x3a3acd390ebd95c5eec4365353c95d9318f61898': 'marketAddress #2',
  '0x829d525f10be754c0b4bca035dc40dcf372e8b11': 'marketAddress #3',
  '0x10a03e7d6fab75599d1c3129d991e271882ebb2b': 'marketAddress #4',
  '0xe9923b742d015756d0978d0bd0601e9542b05027': 'mkt 0x1888',
  '0xee2773080d69d77f3d244cd11585a4dba0be9fd4': 'mkt 0x1887',
};
const map = new Map();
for (let n = 0; n <= 1200; n++) {
  const a = getContractAddress({ from: DEPLOYER, nonce: BigInt(n) }).toLowerCase();
  map.set(a, n);
}
let hits = 0;
for (const [addr, label] of Object.entries(KNOWN)) {
  const n = map.get(addr.toLowerCase());
  if (n !== undefined) { console.log(`MATCH  nonce=${n}  ${addr}  (${label})`); hits++; }
  else console.log(`no     ${addr}  (${label})`);
}
console.log(`\nCREATE-nonce matches: ${hits}/${Object.keys(KNOWN).length}`);
