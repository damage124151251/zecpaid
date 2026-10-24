import { Keypair } from '@solana/web3.js';
import { AppError, handle, seal } from './security.mjs';
export function normalizeAccount(body) {
  const value = body?.data;
  if (!value || !/^\d{1,30}$/.test(value.id) || !value.name) throw new AppError('X did not return a valid account identity.', 502);
  const avatar = typeof value.profile_image_url === 'string' && /^https:\/\/pbs\.twimg\.com\//.test(value.profile_image_url) ? value.profile_image_url : null;
  return { id: value.id, username: handle(value.username), name: String(value.name).slice(0, 100), avatar };
}
export async function rememberAccount(db, account) {
  await db.run('INSERT INTO accounts(x_id,username,name,avatar,updated) VALUES($1,$2,$3,$4,$5) ON CONFLICT(x_id) DO UPDATE SET username=excluded.username,name=excluded.name,avatar=excluded.avatar,updated=excluded.updated', account.id, account.username, account.name, account.avatar, Date.now());
  return account;
}
export async function collectorWallet(db, xId, encryptionKey) {
  if (!/^\d{1,30}$/.test(xId)) throw new AppError('A verified X account ID is required.');
  return db.tx(async () => {
    const existing = await db.get('SELECT address FROM wallets WHERE x_id=$1', xId);
    if (existing) return existing.address;
    if (!await db.get('SELECT x_id FROM accounts WHERE x_id=$1', xId)) throw new AppError('Resolve this account with X first.', 409);
    const pair = Keypair.generate(), address = pair.publicKey.toBase58();
    await db.run('INSERT INTO wallets(x_id,address,secret,created) VALUES($1,$2,$3,$4)', xId, address, seal(pair.secretKey, `wallet:${xId}:${address}`, encryptionKey), Date.now());
    return address;
  });
}
export function xProvider(fetcher = fetch) {
  async function get(url, token) {
    let r;
    try { r = await fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000), redirect: 'error' }); }
    catch { throw new AppError('X could not be reached. Try again shortly.', 502); }
    if (r.status === 404) throw new AppError('That X account was not found.', 404);
    if (r.status === 429) throw new AppError('X has limited profile requests. Wait before trying again.', 429);
    if (!r.ok) throw new AppError('X rejected the request. The operator must check API access and credits.', 503);
    return normalizeAccount(await r.json());
  }
  return {
    lookup: name => {
      if (!process.env.X_BEARER_TOKEN) throw new AppError('X profile lookup needs the operator\'s X API credentials. No account has been verified.', 503);
      return get(`https://api.x.com/2/users/by/username/${handle(name)}?user.fields=profile_image_url`, process.env.X_BEARER_TOKEN);
    },
    me: token => get('https://api.x.com/2/users/me?user.fields=profile_image_url', token),
    exchange: async (code, verifier, redirectUri) => {
      const body = new URLSearchParams({ code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
      let r;
      try { r = await fetcher('https://api.x.com/2/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64')}` }, body, signal: AbortSignal.timeout(12000), redirect: 'error' }); }
      catch { throw new AppError('The X sign-in request timed out. Start a new sign-in.', 502); }
      if (!r.ok) throw new AppError('X could not finish sign-in. Check the app callback URL and credentials.', 503);
      const data = await r.json();
      if (!data.access_token || data.token_type?.toLowerCase() !== 'bearer') throw new AppError('X returned an invalid access token.', 502);
      return data.access_token;
    }
  };
}
