import { PublicKey } from '@solana/web3.js';
import { AppError } from './security.mjs';
import project from '../shared/project.json' with { type: 'json' };
export async function rpc(method, params, fetcher = fetch) {
  let r;
  try { r = await fetcher(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) }); }
  catch { throw new AppError('Solana is taking too long to respond. No transaction has been retried.', 503); }
  if (!r.ok) throw new AppError('The Solana RPC is unavailable. Try again shortly.', 503);
  const body = await r.json();
  if (body.error) throw new AppError('Solana could not complete this request.', 503);
  return body.result;
}
export async function balances(address, read = rpc) {
  new PublicKey(address);
  const sol = await read('getBalance', [address, { commitment: 'finalized' }]);
  const tokens = await read('getTokenAccountsByOwner', [address, { mint: project.zecMint }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
  let zec = 0n;
  for (const row of tokens.value || []) {
    const a = row.account?.data?.parsed?.info;
    if (a?.owner !== address || a?.mint !== project.zecMint || a?.tokenAmount?.decimals !== project.zecDecimals || !/^\d+$/.test(a.tokenAmount.amount)) throw new AppError('The RPC returned an unsupported ZEC balance.', 502);
    zec += BigInt(a.tokenAmount.amount);
  }
  if (!Number.isSafeInteger(sol.value) || sol.value < 0) throw new AppError('The RPC returned an invalid SOL balance.', 502);
  return { address, solLamports: String(sol.value), zecRaw: String(zec), checked: Date.now(), commitment: 'finalized', source: 'wallet balance, not attributed creator revenue' };
}
