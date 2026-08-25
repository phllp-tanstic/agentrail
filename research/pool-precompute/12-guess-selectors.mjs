// Brute-force candidate function signatures against the unresolved selectors.
import { keccak256, toHex } from 'viem';
const sel = (sig) => keccak256(toHex(sig)).slice(0, 10);

const UNRESOLVED = ['0x03684f95','0x3a0afa7f','0x4381b341','0x443635a3','0x7bbc67e6','0x7f1e31ce',
  '0xaf1e64a8','0xccb0797d','0xcdf7260d','0x019daeeb','0x2570a0d9','0x703e46dd','0x2a875269','0x1afcd79f'];
const want = new Set(UNRESOLVED);

// ---- build candidate signature space ----
const cands = new Set();
const add = (s) => cands.add(s);

// Known-shape building blocks
const A = 'address', A2 = 'address[]', B4 = 'bytes4', B4A = 'bytes4[]', BOOL = 'bool',
      B4AA = 'bytes4[][]', BOOLA = 'bool[]', U = 'uint256', BYTES = 'bytes', BYTESA = 'bytes[]';

// 1) the known singular fn and every plausible plural/batch variant
const bases = ['setOperatorApprovalForPool','setOperatorApprovalForPools','setOperatorApproval',
  'setOperatorApprovals','setApprovalForPool','setApprovalForPools','batchSetOperatorApprovalForPool',
  'batchSetOperatorApprovalForPools','batchSetOperatorApproval','setOperatorApprovalForAllPools',
  'setOperatorApprovalBatch','operatorApprovalBatch','setPoolOperatorApproval','setPoolOperatorApprovals',
  'batchSetPoolOperatorApproval','setOperatorApprovalForPoolBatch','multiSetOperatorApprovalForPool'];
const argsets = [
  [A,A,B4A,BOOL],[A2,A,B4A,BOOL],[A2,A2,B4A,BOOL],[A2,A,B4AA,BOOL],[A2,A,B4A,BOOLA],
  [A2,A2,B4AA,BOOLA],[A,A,B4A,BOOL,U],[A2,A,B4A],[A2,A],[A,A,BOOL],[A2,A,BOOL],
  [A,A,B4,BOOL],[A2,A,B4,BOOL],[A2,A2,B4A,BOOLA],[A,A2,B4A,BOOL],[A,A2,B4AA,BOOLA],
];
for (const b of bases) for (const a of argsets) add(`${b}(${a.join(',')})`);

// 2) generic multicall / batch entrypoints
for (const n of ['multicall','multicallable','batch','batchCall','multiCall','aggregate','aggregate3',
  'tryAggregate','multiSend','multisend','execute','executeBatch','multiDelegatecall','multicallDelegate']) {
  for (const a of [[BYTESA],[BYTESA,BOOL],[BOOL,BYTESA],[BYTES],[U,BYTESA],[A2,BYTESA],[A,BYTES]]) add(`${n}(${a.join(',')})`);
}

// 3) views / registry-ish reads (to identify remaining unresolved as views)
const views = ['isApprovedForPool','isOperatorApprovedForPool','isOperatorApproved','isApproved',
  'operatorApproval','operatorApprovals','poolOperatorApproval','isRegistered','registerPool',
  'isPoolRegistered','poolFactory','factory','registry','getApprovedSelectors','approvedSelectors',
  'getOperators','operators','isApprovedForAll','hasPermission','canOperate','checkPermission',
  'isOperatorFor','getPoolOperator','version','initialize','setPoolFactory','setFactory',
  'setRegistry','addFactory','removeFactory','isFactory','authorizedFactories','poolRegistry'];
for (const v of views) {
  for (const a of [[],[A],[A,A],[A,A,A],[A,A,B4],[A,A,A,B4],[A,A,A,B4A],[A,B4],[A,A,BOOL],[A2],[A,U],[BOOL],[A,A,A,BOOL]]) add(`${v}(${a.join(',')})`);
}

// 4) common OZ / init errors + misc to close out the list
for (const e of ['NotInitializing()','AlreadyInitialized()','UUPSUnauthorizedCallContext()',
  'UUPSUnsupportedProxiableUUID(bytes32)','InvalidPool()','PoolNotRegistered()','NotPoolOwner()',
  'Unauthorized()','InvalidSelector()','LengthMismatch()','ArrayLengthMismatch()','EmptyArray()',
  'ZeroAddress()','InvalidAddress()','NotRegistered()','AlreadyRegistered()','InvalidOperator()',
  'OperatorApprovalSet(address,address,address,bytes4,bool)',
  'OperatorApprovalUpdated(address,address,address,bytes4[],bool)',
  'OperatorApprovalChanged(address,address,address,bytes4,bool)',
  'PoolRegistered(address)','Initialized(uint64)']) add(e);

// ---- match ----
const hits = new Map();
for (const c of cands) { const s = sel(c); if (want.has(s)) { if (!hits.has(s)) hits.set(s, []); hits.get(s).push(c); } }

console.log(`candidate space: ${cands.size} signatures`);
console.log('\n=== KNOWN reference selectors ===');
for (const s of ['setOperatorApprovalForPool(address,address,bytes4[],bool)',
  'multicall(bytes[])','isRegistered(address)','aggregate3((address,bool,bytes)[])'])
  console.log(`  ${sel(s)}  ${s}`);

console.log('\n=== MATCHES against unresolved ===');
for (const u of UNRESOLVED) {
  console.log(`  ${u}  ${hits.has(u) ? '>>> ' + hits.get(u).join('  ||  ') : '(still unknown)'}`);
}
