export const MAINNET = 'https://api.infra.mainnet.somnia.network/';
export const TESTNET = 'https://dream-rpc.somnia.network/';
let id = 0;
export async function rpc(method, params = [], url = MAINNET) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error));
  return j.result;
}
export const gql = async (q, url='https://prd.smk.somnia.host/v1/graphql') => {
  const r = await fetch(url, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
};
