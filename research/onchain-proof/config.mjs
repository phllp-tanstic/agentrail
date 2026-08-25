// Shared config for all AgentRail on-chain proof scripts.
// KEY INJECTION: set exactly ONE env var to unblock every signed step:
//     AGENTRAIL_OWNER_KEY=0x<64 hex>      (the position OWNER / fund key)
// Optional second var, only if you want a distinct operator signer:
//     AGENTRAIL_OPERATOR_KEY=0x<64 hex>   (defaults to a generated ephemeral key)
import { SOMNIA_TESTNET_ADDRESSES, SOMNIA_MAINNET_ADDRESSES } from '@somnia-chain/markets-sdk';
import { somniaShannon, somniaMainnet } from '@somnia-chain/markets-sdk/chains';

export const TESTNET_RPC = 'https://api.infra.testnet.somnia.network';
export const MAINNET_RPC = 'https://api.infra.mainnet.somnia.network';
export const TESTNET_INDEXER = 'https://dev.smk.somnia.host/v1/graphql';
export const MAINNET_INDEXER = 'https://prd.smk.somnia.host/v1/graphql';

// OperatorPermissionsRegistry is NOT present in SOMNIA_*_ADDRESSES - must be supplied manually.
export const OPERATOR_REGISTRY = {
  testnet: '0x15C7e8CE38F021c5b45d098AaD788f63090bF20A',
  mainnet: '0xE7a190736B6024a4DbafadC04E283075877005ce',
};

export const CORE = {
  binaryMarketsModule: '0x3ecC694Cef705358864a646142ac17A90E29e388',
  outcomeToken6909:    '0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9',
  binarySettlement:    '0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23',
  oracleHub:           '0xe40db387cC98601Dd11bd634fF2f3AD5686dE32b',
};

// Known LIVE MAINNET binary pools (read-only probes / 18-decimal tick math).
export const MAINNET_POOLS = {
  ETH: '0x39b910486dbc82510d0990caa8b4af05da864bb4',
  BTC: '0xd22908ed947495d4d3dac8c75e75a5cf495ff736',
};

// Operator delegation selectors (confirmed against SDK exports).
export const SEL = {
  placeOrderFor:  '0x80054449',
  cancelOrderFor: '0xe37b444b',
  reduceOrderFor: '0x364c2587',
};

export const TESTNET_CFG = {
  chain: somniaShannon,
  rpcUrl: TESTNET_RPC,
  indexerUrl: TESTNET_INDEXER,
  addresses: SOMNIA_TESTNET_ADDRESSES,
};

export const MAINNET_CFG = {
  chain: somniaMainnet,
  rpcUrl: MAINNET_RPC,
  indexerUrl: MAINNET_INDEXER,
  addresses: SOMNIA_MAINNET_ADDRESSES,
};

export const OWNER_KEY = process.env.AGENTRAIL_OWNER_KEY || null;
export const OPERATOR_KEY = process.env.AGENTRAIL_OPERATOR_KEY || null;
export const HAVE_KEY = !!OWNER_KEY;

/** Raw eth_call helper - works with an arbitrary `from`, no key needed. */
export async function ethCall(rpc, { from, to, data, blockTag = 'latest' }) {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ ...(from ? { from } : {}), to, data }, blockTag],
  };
  const r = await fetch(rpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}

/** Pull the revert selector + payload out of whatever shape the node returns. */
export function extractRevertData(j) {
  if (!j || !j.error) return null;
  const e = j.error;
  const cands = [e.data, e.data?.data, e.data?.originalError?.data, e.message];
  for (const c of cands) {
    if (typeof c === 'string') {
      const m = c.match(/0x[0-9a-fA-F]{8,}/);
      if (m) return m[0];
      if (/^0x$/.test(c.trim())) return '0x';
    }
  }
  return null;
}
