// STEP 5: find FINALIZED markets (the ones the live listing skips) - READ-ONLY.
// STEP 6: exercise the redeemFor / signRedeemAuth RELAYER path.
//
// Key insight that gets us further than expected with no funded key:
// signRedeemAuth needs a SIGNER, not FUNDS. We generate a synthetic owner keypair
// (we control it), produce a REAL EIP-712 RedeemAuthorization signature, then
// eth_call redeemFor from a separate synthetic relayer address. If the module's
// signature recovery works, the revert will be about the owner having no position -
// NOT about a bad signature. That proves the whole relayer signature scheme
// end-to-end without a single funded account.
import { encodeFunctionData } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { SomniaMarkets, binaryModuleWriteAbi, binarySettlementAbi,
         SOMNIA_TESTNET_ADDRESSES } from '@somnia-chain/markets-sdk';
import { TESTNET_CFG, TESTNET_RPC, ethCall, extractRevertData, HAVE_KEY, CORE } from './config.mjs';
import fs from 'node:fs';

const ERRMAP = JSON.parse(fs.readFileSync('error-selectors.json', 'utf8'));
function decodeRevert(d) {
  if (d === null) return 'NO REVERT DATA';
  if (d === '0x') return 'EMPTY 0x  <-- no selector: function absent / not dispatched';
  const s = d.slice(0, 10).toLowerCase();
  const named = ERRMAP[s];
  let out = `${s} = ${named ?? 'UNKNOWN (absent from contractErrorsAbi)'}`;
  if (named && d.length > 10) {
    const types = named.slice(named.indexOf('(') + 1, -1).split(',').filter(Boolean);
    const words = d.slice(10).match(/.{64}/g) || [];
    out += `  ( ${words.map((w, i) => (types[i] === 'address' ? `address=0x${w.slice(24)}` : `${types[i] ?? '?'}=${BigInt('0x' + w)}`)).join(', ')} )`;
  }
  return out;
}

const ex = new SomniaMarkets(TESTNET_CFG);

// ============================================================== STEP 5
console.log('='.repeat(78));
console.log('=== STEP 5: FINALIZED markets (the live listing skips these) ===');
const live = await ex.client.listLiveBinaryMarkets();
console.log(`listLiveBinaryMarkets()                    -> ${live.length}`,
            `statuses: ${JSON.stringify([...new Set(live.map(m => m.status))])}`);

const fin = await ex.client.listBinaryMarkets({ status: 'Finalized', limit: 50 });
console.log(`listBinaryMarkets({status:"Finalized"})    -> ${fin.length}`,
            `statuses: ${JSON.stringify([...new Set(fin.map(m => m.status))])}`);
const liveIds = new Set(live.map(m => m.marketId));
const overlap = fin.filter(m => liveIds.has(m.marketId)).length;
console.log(`overlap between live and finalized sets    -> ${overlap} (expect 0)`);
console.log(overlap === 0
  ? 'CONFIRMED: the live listing does NOT surface finalized markets. A position in a\n'
  + '           finalized market is only discoverable via listBinaryMarkets({status:"Finalized"}).\n'
  + '           An agent that only walks the live listing will silently never redeem.'
  : 'UNEXPECTED overlap');

if (fin[0]) {
  const f = fin[0];
  console.log('\nsample FINALIZED market:');
  console.log(JSON.stringify({ marketId: f.marketId, pool: f.poolAddress, asset: f.asset,
    status: f.status, finalized: f.finalized, voided: f.voided, winningOutcome: f.winningOutcome,
    payoutNumerators: f.payoutNumerators, payoutDenominator: f.payoutDenominator,
    yesTokenId: f.yesTokenId, noTokenId: f.noTokenId, expiry: f.expiry }, null, 2));
  const oc = await ex.client.getMarketOnchain(f.marketId).catch(e => ({ err: e.message }));
  console.log('getMarketOnchain(finalized) status =', oc.status, 'finalized =', oc.finalized,
              'isResolved =', oc.isResolved, 'winningOutcome =', oc.winningOutcome);
}

console.log('\n--- confirming OUR position appears (requires step 4 to have executed) ---');
console.log('BLOCKED: no order was ever placed (no key), so there is no position of ours to find.');
console.log('The read path above is proven; the "our position appears" assertion is not.');

// ============================================================== STEP 6
console.log('\n' + '='.repeat(78));
console.log('=== STEP 6: redeemFor / signRedeemAuth relayer path ===');

const MODULE = SOMNIA_TESTNET_ADDRESSES.binaryModule ?? CORE.binaryMarketsModule;
console.log('BinaryMarketsModule =', MODULE, '(SDK addresses.binaryModule)');
console.log('CORE.binaryMarketsModule (ground truth) =', CORE.binaryMarketsModule,
            '| match:', String(MODULE).toLowerCase() === CORE.binaryMarketsModule.toLowerCase());

const ownerAcct = privateKeyToAccount('0x' + '11'.repeat(32));   // synthetic owner WE control
const relayer  = privateKeyToAccount(generatePrivateKey()).address; // synthetic relayer
console.log('synthetic owner (signs)  :', ownerAcct.address);
console.log('synthetic relayer (sends):', relayer);

const target = fin[0];
if (!target) { console.log('no finalized market available; cannot build a redeem probe'); process.exit(0); }

const auth = {
  owner: ownerAcct.address,
  operatorId: target.operatorId ?? 0,
  venueId: target.venueId ?? ('0x' + '00'.repeat(32)),
  marketId: target.marketId,
  outcomeIdx: 0,                                   // YES
  amount: 1000n,                                   // 1 minQuantity at 6 dec
  nonce: 1n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
};

// ---- produce a REAL EIP-712 signature (mirrors SDK signRedeemAuth exactly)
const domain = { name: 'SomniaMarkets', version: '1', chainId: TESTNET_CFG.chain.id, verifyingContract: MODULE };
const types = { RedeemAuthorization: [
  { name: 'owner', type: 'address' }, { name: 'operatorId', type: 'uint32' },
  { name: 'venueId', type: 'bytes32' }, { name: 'marketId', type: 'bytes32' },
  { name: 'outcomeIdx', type: 'uint8' }, { name: 'amount', type: 'uint256' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const signature = await ownerAcct.signTypedData({ domain, types, primaryType: 'RedeemAuthorization', message: auth });
console.log('\nREAL EIP-712 signature produced by the owner key:', signature);
console.log('  (65 bytes:', (signature.length - 2) / 2, ')');

// verify locally that it recovers to the owner
const { verifyTypedData } = await import('viem');
const recovers = await verifyTypedData({ address: ownerAcct.address, domain, types,
  primaryType: 'RedeemAuthorization', message: auth, signature });
console.log('  local recovery -> owner?', recovers);

// ---- encode + simulate redeemFor from the RELAYER
const redeemForData = encodeFunctionData({ abi: binaryModuleWriteAbi, functionName: 'redeemFor',
  args: [auth.owner, auth.nonce, auth.deadline, signature, auth.operatorId, auth.venueId,
         auth.marketId, auth.outcomeIdx, auth.amount] });
console.log('\nredeemFor selector', redeemForData.slice(0, 10), '| bytes', (redeemForData.length - 2) / 2);

// CONTROL: bogus selector must give empty 0x
const bogus = '0xdeadbe02' + redeemForData.slice(10);
console.log('[CONTROL] bogus selector ->',
  decodeRevert(extractRevertData(await ethCall(TESTNET_RPC, { from: relayer, to: MODULE, data: bogus }))));

const r1 = await ethCall(TESTNET_RPC, { from: relayer, to: MODULE, data: redeemForData });
console.log('[REAL SIG]  redeemFor  ->', r1.error ? decodeRevert(extractRevertData(r1)) : `NO REVERT, returned ${r1.result}`);

// ---- negative control: same call, CORRUPTED signature. Different revert => sig is really checked.
const badSig = signature.slice(0, -4) + (signature.slice(-4) === 'dead' ? 'beef' : 'dead');
const badData = encodeFunctionData({ abi: binaryModuleWriteAbi, functionName: 'redeemFor',
  args: [auth.owner, auth.nonce, auth.deadline, badSig, auth.operatorId, auth.venueId,
         auth.marketId, auth.outcomeIdx, auth.amount] });
const r2 = await ethCall(TESTNET_RPC, { from: relayer, to: MODULE, data: badData });
console.log('[BAD SIG]   redeemFor  ->', r2.error ? decodeRevert(extractRevertData(r2)) : `NO REVERT, returned ${r2.result}`);

// ---- expired deadline control
const expAuth = { ...auth, deadline: 1n };
const expSig = await ownerAcct.signTypedData({ domain, types, primaryType: 'RedeemAuthorization', message: expAuth });
const expData = encodeFunctionData({ abi: binaryModuleWriteAbi, functionName: 'redeemFor',
  args: [expAuth.owner, expAuth.nonce, expAuth.deadline, expSig, expAuth.operatorId, expAuth.venueId,
         expAuth.marketId, expAuth.outcomeIdx, expAuth.amount] });
const r3 = await ethCall(TESTNET_RPC, { from: relayer, to: MODULE, data: expData });
console.log('[EXPIRED]   redeemFor  ->', r3.error ? decodeRevert(extractRevertData(r3)) : `NO REVERT, returned ${r3.result}`);

// ---- redeemMany + direct settlement redeem, encoded for completeness
const many = encodeFunctionData({ abi: binaryModuleWriteAbi, functionName: 'redeemMany',
  args: [0, '0x' + '00'.repeat(32), [target.marketId], [0], [1000n]] });
console.log('\nredeemMany selector', many.slice(0, 10));
const rm = await ethCall(TESTNET_RPC, { from: ownerAcct.address, to: MODULE, data: many });
console.log('  redeemMany (self) ->', rm.error ? decodeRevert(extractRevertData(rm)) : `NO REVERT ${rm.result}`);

const direct = encodeFunctionData({ abi: binarySettlementAbi, functionName: 'redeem',
  args: [BigInt(target.yesTokenId), 1000n, ownerAcct.address] });
console.log('BinarySettlement.redeem selector', direct.slice(0, 10));
const rd = await ethCall(TESTNET_RPC, { from: ownerAcct.address, to: CORE.binarySettlement, data: direct });
console.log('  settlement.redeem ->', rd.error ? decodeRevert(extractRevertData(rd)) : `NO REVERT ${rd.result}`);

console.log('\n=== SIGNED EXECUTION ===');
if (!HAVE_KEY) {
  console.log('BLOCKED: no AGENTRAIL_OWNER_KEY. redeemFor was simulated but never submitted.');
  console.log('TX HASH: none - BLOCKED.');
  console.log('Cannot confirm proceeds land in the OWNER wallet, because no position exists to redeem.');
  console.log('\nExact tx a relayer would broadcast:');
  console.log(JSON.stringify({ chainId: 50312, from: relayer, to: MODULE, data: redeemForData, value: '0x0' }, null, 2));
}

fs.writeFileSync('step5-6-artifacts.json', JSON.stringify({
  liveCount: live.length, finalizedCount: fin.length, overlap,
  module: MODULE, finalizedSample: target?.marketId,
  auth: { ...auth, amount: auth.amount.toString(), nonce: auth.nonce.toString(), deadline: auth.deadline.toString() },
  signature, redeemForCalldata: redeemForData,
}, null, 2));
console.log('\n-> wrote step5-6-artifacts.json');
process.exit(0);
