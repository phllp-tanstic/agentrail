// One-off helper: calls the tUSDC test-token's public faucet() function to
// fund ONE session's dedicated wallet. This mints/dispenses test collateral
// directly via the ERC20 contract on Somnia testnet — no website faucet
// exists for tUSDC, unlike SOMI (native gas), which does need one.
//
// Usage:  node build/fund-tusdc.mjs <session_id>
//
// Reuses the exact call proven live in phase-a-lifecycle.mjs STEP 0 — same
// FAUCET_PER_TX() read, same faucet(uint256) call — just aimed at a session's
// own dedicated wallet instead of the legacy AGENTRAIL_OWNER_KEY wallet.
import { createPublicClient, createWalletClient, http, parseAbi,
  encodeFunctionData, formatUnits } from 'viem';
import { somniaShannon } from '@somnia-chain/markets-sdk/chains';
import * as SDK from '@somnia-chain/markets-sdk';
import { _privateKeyForSession } from './wallet.mjs';

const RPC = process.env.SOMNIA_RPC_URL ?? somniaShannon.rpcUrls.default.http[0];
const A = SDK.SOMNIA_TESTNET_ADDRESSES;
const COLL = A.collateral;

const sessionId = process.argv[2];
if (!sessionId) { console.error('Usage: node build/fund-tusdc.mjs <session_id>'); process.exit(1); }

const pk = _privateKeyForSession(sessionId);
if (!pk) { console.error(`No wallet exists yet for session_id="${sessionId}". Run generate_wallet first.`); process.exit(1); }

const { privateKeyToAccount } = await import('viem/accounts');
const owner = privateKeyToAccount(pk);
const pc = createPublicClient({ chain: somniaShannon, transport: http(RPC) });
const wc = createWalletClient({ account: owner, chain: somniaShannon, transport: http(RPC) });

console.log('session:', sessionId, '| wallet:', owner.address);

const balBefore = await pc.readContract({ address: COLL,
  abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [owner.address] });
console.log('tUSDC before:', formatUnits(balBefore, 6));

const per = await pc.readContract({ address: COLL,
  abi: parseAbi(['function FAUCET_PER_TX() view returns (uint256)']), functionName: 'FAUCET_PER_TX' });
console.log('FAUCET_PER_TX:', formatUnits(per, 6), '-> calling faucet()');

const hash = await wc.sendTransaction({ to: COLL, data: encodeFunctionData({
  abi: parseAbi(['function faucet(uint256)']), functionName: 'faucet', args: [per] }) });
const rcpt = await pc.waitForTransactionReceipt({ hash });
console.log('tx:', hash, '| status:', rcpt.status);

const balAfter = await pc.readContract({ address: COLL,
  abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [owner.address] });
console.log('tUSDC after:', formatUnits(balAfter, 6));
