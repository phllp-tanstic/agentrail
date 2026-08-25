// Constrained brute-force: the 6 unknown registry fns have KNOWN head-word counts.
// 0x3a0afa7f: 4 head words, WRITE, reverts InvalidOperator() on zero args
// 0x7f1e31ce: 3 head words, WRITE, reverts InvalidOperator() on zero args
// 0x4381b341: 4 head words, VIEW -> 32 bytes
// 0xccb0797d: 4 head words, VIEW -> 32 bytes
// 0xcdf7260d: 3 head words, VIEW -> 32 bytes
// 0x443635a3: >=1 word,     onlyOwner WRITE
// 0xaf1e64a8: 0 words,      VIEW -> address
import { keccak256, toHex } from 'viem';
const S = (sig) => keccak256(toHex(sig)).slice(0, 10);

const TARGET = {
  '0x3a0afa7f': { words: 4, kind: 'write' }, '0x7f1e31ce': { words: 3, kind: 'write' },
  '0x4381b341': { words: 4, kind: 'view' }, '0xccb0797d': { words: 4, kind: 'view' },
  '0xcdf7260d': { words: 3, kind: 'view' }, '0x443635a3': { words: -1, kind: 'owner' },
  '0xaf1e64a8': { words: 0, kind: 'view' },
  // bonus: unknown error + the factory's unknowns + the system-tx selector
  '0x4ae141b2': { words: -1, kind: 'error' }, '0x0397c452': { words: -1, kind: 'factory' },
  '0xe5352a66': { words: -1, kind: 'factory' }, '0x0be2a601': { words: -1, kind: 'factory' },
};
const want = new Set(Object.keys(TARGET));
const hits = new Map();
const seen = new Set();
let tried = 0;
function test(sig) {
  if (seen.has(sig)) return; seen.add(sig); tried++;
  const s = S(sig);
  if (want.has(s)) { if (!hits.has(s)) hits.set(s, []); hits.get(s).push(sig); }
}

// ---------- vocabulary ----------
const VERBS = ['set', 'batchSet', 'setBatch', 'multiSet', 'update', 'grant', 'grantBatch', 'batchGrant',
  'revoke', 'add', 'remove', 'approve', 'setMany', 'bulkSet', 'configure', 'apply', 'register'];
const NOUNS = ['Operator', 'OperatorApproval', 'OperatorApprovals', 'Approval', 'Approvals',
  'Permission', 'Permissions', 'OperatorPermission', 'OperatorPermissions', 'OperatorSelectors',
  'Selector', 'Selectors', 'PoolOperator', 'PoolOperatorApproval', 'OperatorApprovalFor'];
const SCOPES = ['', 'ForPool', 'ForPools', 'ForAll', 'ForAllPools', 'Global', 'Globally', 'ForAccount',
  'ForOwner', 'Batch', 'ForPoolBatch', 'ForPoolsBatch', 'All', 'Any', 'ForAnyPool', 'ForEveryPool',
  'ForCollection', 'ForMarket', 'ForMarkets', 'ForVault', 'ForVaults'];
const VIEWVERBS = ['is', 'get', 'check', 'has', 'can', 'are', ''];
const VIEWNOUNS = ['Approved', 'OperatorApproved', 'ApprovedFor', 'OperatorApproval', 'Approval',
  'Permission', 'Permitted', 'Allowed', 'OperatorAllowed', 'Operator', 'Authorized', 'OperatorPermission'];

const A = 'address', A2 = 'address[]', B4 = 'bytes4', B4A = 'bytes4[]', B4AA = 'bytes4[][]',
      BO = 'bool', BOA = 'bool[]', U = 'uint256', U8 = 'uint8', B32 = 'bytes32';

// ---- full shape enumeration by arity over a restricted type alphabet ----
const SHAPES = { 0: [[]], 1: [], 2: [], 3: [], 4: [] };
const ALPHA = [A, A2, B4, B4A, B4AA, BO, BOA, U, B32];
function enumerate(n, pre = []) {
  if (pre.length === n) { SHAPES[n].push([...pre]); return; }
  for (const t of ALPHA) { pre.push(t); enumerate(n, pre); pre.pop(); }
}
for (let n = 1; n <= 4; n++) enumerate(n);
console.log('full arg-shape counts by arity:', Object.fromEntries(Object.entries(SHAPES).map(([k, v]) => [k, v.length])));

// ---- CURATED shapes: highly plausible given setOperatorApprovalForPool(address,address,bytes4[],bool) ----
const CURATED = [
  [A2, A, B4A, BO], [A2, A2, B4A, BO], [A2, A, B4AA, BO], [A2, A, B4A, BOA], [A2, A2, B4AA, BOA],
  [A, A2, B4A, BO], [A, A2, B4AA, BOA], [A2, A2, B4AA, BO], [A2, A, B4, BO], [A2, A2, B4, BO],
  [A, A, B4A, BO], [A, A, B4A, BOA], [A, A, B4AA, BO], [A, A, B4, BO], [A, A, BO, BO],
  [A, B4A, BO], [A2, B4A, BO], [A, B4AA, BO], [A, B4A, BOA], [A2, A, B4A], [A2, A, BO],
  [A, A, BO], [A, A, B4A], [A, A, B4], [A, B4, BO], [A2, B4, BO], [A, A2, BO], [A, A2, B4A],
  [A2, A2, BO], [A2, A2, B4A], [A, U, BO], [A, A, U], [A, A, A], [A, A, A, B4], [A, A, A, B4A],
  [A, A, A, BO], [A, A, B4, BOA], [A2, A, B4A, U], [A, A, B4A, U], [A, A, U, BO],
];
const writeNames = new Set();
for (const v of VERBS) for (const n of NOUNS) for (const s of SCOPES) writeNames.add(v + n + s);
for (const n of ['setOperatorApprovalForPools', 'setOperatorApprovalsForPools', 'setOperatorApproval',
  'setOperatorApprovals', 'setApprovalForAll', 'setOperatorApprovalForAll']) writeNames.add(n);
const viewNames = new Set();
for (const v of VIEWVERBS) for (const n of VIEWNOUNS) for (const s of SCOPES) viewNames.add(v + n + s);
for (const n of ['isApprovedForPool', 'isApprovedForPools', 'isApproved', 'operatorApproval',
  'operatorApprovals', 'poolOperatorApproval', 'getApproval', 'approvals', 'globalApproval',
  'globalOperatorApproval', 'isGloballyApproved', 'isApprovedGlobally', 'poolRegistry', 'registry',
  'poolFactory', 'factory', 'getPoolRegistry', 'getRegistry', 'getFactory', 'version', 'VERSION',
  'implementation', 'nonces', 'nonce', 'setPoolRegistry', 'setRegistry', 'setPoolFactory',
  'setFactory', 'updateRegistry', 'updatePoolRegistry']) viewNames.add(n);
const allNames = new Set([...writeNames, ...viewNames]);
console.log(`name candidates: write=${writeNames.size} view=${viewNames.size} union=${allNames.size}`);

// PASS 1: every name x curated shapes  (broad names, narrow shapes)
for (const name of allNames) {
  for (const sh of CURATED) test(`${name}(${sh.join(',')})`);
  test(`${name}()`);
  for (const t of ALPHA) test(`${name}(${t})`);
}
console.log(`after pass 1: ${tried} tried`);

// PASS 2: small curated name list x FULL shape enumeration (narrow names, broad shapes)
const HOT = ['setOperatorApprovalForPools', 'setOperatorApprovalsForPools', 'setOperatorApproval',
  'setOperatorApprovals', 'batchSetOperatorApprovalForPool', 'batchSetOperatorApproval',
  'setOperatorApprovalForAllPools', 'setOperatorApprovalForAll', 'setOperatorApprovalBatch',
  'setPoolOperatorApprovals', 'setPoolOperatorApproval', 'setApprovalForPools', 'setApprovalForPool',
  'setSelectorApprovalForPools', 'setOperatorSelectorsForPools', 'setOperatorPermissions',
  'setOperatorPermissionsForPools', 'grantOperatorForPools', 'approveOperatorForPools',
  'isApprovedForPool', 'isApprovedForPools', 'isApproved', 'isOperatorApproved',
  'isOperatorApprovedForPool', 'operatorApproval', 'getOperatorApproval', 'hasApproval',
  'isOperatorApprovedForAll', 'isApprovedForAll', 'setPoolRegistry', 'setRegistry',
  'poolRegistry', 'registry', 'getPoolRegistry'];
for (const name of HOT) for (let n = 0; n <= 4; n++) for (const sh of SHAPES[n]) test(`${name}(${sh.join(',')})`);
console.log(`after pass 2: ${tried} tried`);

// ---------- errors ----------
for (const e of ['InvalidRegistry()', 'InvalidPoolRegistry()', 'ZeroAddress()', 'InvalidAddress()',
  'InvalidPool()', 'PoolNotRegistered()', 'NotRegistered()', 'InvalidSelector()', 'EmptySelectors()',
  'LengthMismatch()', 'ArrayLengthMismatch()', 'EmptyArray()', 'InvalidLength()', 'NoSelectors()',
  'InvalidFactory()', 'SameRegistry()', 'InvalidOwner()', 'Unauthorized()', 'InvalidInput()',
  'InvalidArrayLength()', 'MismatchedArrayLengths()', 'InvalidPoolRegistryAddress()',
  'RegistryAlreadySet()', 'InvalidCaller()', 'NotPoolOwner()', 'PoolNotFound()']) test(e);

console.log(`\ntried ${tried} candidate signatures\n`);
console.log('=== RESULTS ===');
for (const [sel, meta] of Object.entries(TARGET)) {
  const h = hits.get(sel);
  console.log(`${sel} [${meta.kind}, ${meta.words < 0 ? '?' : meta.words} words]  ${h ? '>>> ' + h.join('  ||  ') : '(no match)'}`);
}
console.log('\n=== reference ===');
for (const r of ['setOperatorApprovalForPool(address,address,bytes4[],bool)',
  'setOperatorApprovalForPools(address[],address,bytes4[],bool)',
  'setOperatorApproval(address,bytes4[],bool)',
  'isApprovedForPool(address,address,address,bytes4)',
  'registerPools(address[])', 'registerPool(address)', 'isRegistered(address)'])
  console.log(`  ${S(r)}  ${r}`);
