import express from 'express';
import helmet from 'helmet';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.mjs';
import { AppError, random, hash, pkce, equal, keyReady, origin, cookie, cookies, sameOrigin, handle, text, seal, unseal } from './security.mjs';
import { xProvider, rememberAccount, collectorWallet } from './accounts.mjs';
import { balances } from './chain.mjs';
import { prepareLaunch, confirmLaunch, reconcile, signingEnabled } from './launches.mjs';
import project from '../shared/project.json' with { type: 'json' };
export function createApp(options = {}) {
  const app = express(), provider = options.provider || xProvider();
  let database;
  const db = async () => { database ??= options.database ? Promise.resolve(options.database) : openDatabase().catch(e => { database = undefined; throw e; }); return database; };
  app.disable('x-powered-by'); app.use(helmet({ contentSecurityPolicy: false })); app.use(express.json({ limit: '3mb' }));
  const buckets = new Map();
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { try { sameOrigin(req); } catch (e) { return next(e); } }
    const ip = process.env.VERCEL ? String(req.headers['x-forwarded-for'] || '').split(',')[0] : req.socket.remoteAddress;
    const t = Math.floor(Date.now() / 60000), old = buckets.get(ip), count = old?.t === t ? old.count + 1 : 1;
    if (buckets.size > 5000) for (const [k, v] of buckets) if (v.t !== t) buckets.delete(k);
    buckets.set(ip, { t, count });
    if (count > 100) return next(new AppError('Too many requests. Try again in a minute.', 429));
    next();
  });
  const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (e) { next(e); } };
  async function session(req) {
    const token = cookies(req).zp_session;
    if (!token) throw new AppError('Sign in with X to use your account.', 401);
    const s = await (await db()).get('SELECT a.* FROM sessions s JOIN accounts a ON a.x_id=s.x_id WHERE s.hash=$1 AND s.expires>$2', hash(token), Date.now());
    if (!s) throw new AppError('Your sign-in expired. Connect X again.', 401);
    return s;
  }
  const oauthReady = () => Boolean(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET && keyReady());
  app.get('/api/status', route(async (req, res) => {
    let storage = true; try { await db(); } catch { storage = false; }
    res.json({ ...project, storage, oauthReady: oauthReady() && storage, lookupReady: Boolean(process.env.X_BEARER_TOKEN) && storage, vaultReady: keyReady() && storage, launchReady: signingEnabled() && oauthReady() && storage && Boolean(process.env.X_BEARER_TOKEN), privatePayoutReady: false, feeSweepsReady: false, callbackUrl: `${origin(req)}/api/auth/callback`, canonicalUrl: origin(req), checkedAt: Date.now() });
  }));
  app.get('/api/auth/start', route(async (req, res) => {
    if (req.get('host') !== new URL(origin(req)).host) return res.redirect(`${origin(req)}/api/auth/start`);
    if (!oauthReady()) throw new AppError('The operator must register the ZecPaid app with X and add its OAuth credentials. No installation is needed by visitors.', 503);
    const d = await db(), state = random(), browser = random(), verifier = random();
    await d.run('DELETE FROM auth_attempts WHERE expires<$1', Date.now());
    await d.run('INSERT INTO auth_attempts(state,browser,verifier,expires) VALUES($1,$2,$3,$4)', hash(state), hash(browser), seal(Buffer.from(verifier), `oauth:${hash(state)}`), Date.now() + 600000);
    cookie(res, 'zp_oauth', browser, 600);
    const u = new URL('https://x.com/i/oauth2/authorize');
    u.search = new URLSearchParams({ response_type: 'code', client_id: process.env.X_CLIENT_ID, redirect_uri: `${origin(req)}/api/auth/callback`, scope: 'tweet.read users.read', state, code_challenge: pkce(verifier), code_challenge_method: 'S256' }).toString();
    res.redirect(u.href);
  }));
  app.get('/api/auth/callback', route(async (req, res) => {
    const state = String(req.query.state || '');
    if (state.length > 100 || !req.query.code || req.query.error) throw new AppError('X sign-in was cancelled. Start again from ZecPaid.');
    const d = await db();
    const attempt = await d.tx(async () => {
      const a = await d.get('SELECT * FROM auth_attempts WHERE state=$1', hash(state));
      if (!a || Number(a.expires) < Date.now() || !equal(a.browser, hash(cookies(req).zp_oauth || ''))) throw new AppError('This sign-in link expired or belongs to another browser.', 403);
      await d.run('DELETE FROM auth_attempts WHERE state=$1', hash(state)); return a;
    });
    const token = await provider.exchange(String(req.query.code), unseal(attempt.verifier, `oauth:${hash(state)}`).toString(), `${origin(req)}/api/auth/callback`);
    const account = await provider.me(token);
    await rememberAccount(d, account);
    await collectorWallet(d, account.id);
    const sid = random();
    await d.run('INSERT INTO sessions(hash,x_id,expires) VALUES($1,$2,$3)', hash(sid), account.id, Date.now() + 8 * 3600000);
    cookie(res, 'zp_session', sid, 8 * 3600); cookie(res, 'zp_oauth', '', 0);
    res.redirect(`${origin(req)}/?signed=in`);
  }));
  app.get('/api/me', route(async (req, res) => {
    try { const a = await session(req), wallet = await (await db()).get('SELECT address FROM wallets WHERE x_id=$1', a.x_id); res.json({ id: a.x_id, username: a.username, name: a.name, avatar: a.avatar, wallet: wallet?.address }); }
    catch (e) { if (e.status === 401) return res.json(null); throw e; }
  }));
  app.post('/api/auth/logout', route(async (req, res) => { const token = cookies(req).zp_session; if (token) await (await db()).run('DELETE FROM sessions WHERE hash=$1', hash(token)); cookie(res, 'zp_session', '', 0); res.json({ ok: true }); }));
  app.get('/api/accounts/:username', route(async (req, res) => {
    const name = handle(req.params.username), d = await db();
    const account = await provider.lookup(name);
    await rememberAccount(d, account);
    const wallet = await d.get('SELECT address FROM wallets WHERE x_id=$1', account.id);
    res.json({ ...account, wallet: wallet?.address || null });
  }));
  app.get('/api/projects', route(async (req, res) => { const a = await session(req); res.json(await (await db()).all('SELECT p.id,p.name,p.symbol,p.description,p.created,p.frozen,a.username FROM projects p JOIN accounts a ON a.x_id=p.recipient WHERE p.owner=$1 ORDER BY p.created DESC LIMIT 100', a.x_id)); }));
  app.post('/api/projects', route(async (req, res) => {
    const a = await session(req), d = await db(), input = req.body;
    const name = text(input.name, 'Name', 1, 32), symbol = text(input.symbol, 'Ticker', 1, 10).toUpperCase();
    if (!/^[A-Z0-9_]{1,10}$/.test(symbol)) throw new AppError('Use letters, numbers or underscores for the ticker.');
    const description = text(input.description, 'Description', 10, 500);
    const recipient = await provider.lookup(handle(input.username));
    if (recipient.id !== input.recipientId) throw new AppError('The X username changed since lookup. Look up the beneficiary again.', 409);
    await rememberAccount(d, recipient);
    if (typeof input.image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(input.image)) throw new AppError('Choose a PNG, JPEG or WebP token image.');
    const bytes = Buffer.from(input.image.split(',')[1], 'base64');
    if (bytes.length > 2 * 1024 * 1024) throw new AppError('Choose an image smaller than 2 MiB.');
    let image;
    try { image = await sharp(bytes, { limitInputPixels: 16000000 }).resize(512, 512, { fit: 'cover' }).png().toBuffer(); } catch { throw new AppError('The image could not be decoded. Choose another image.'); }
    const address = await collectorWallet(d, recipient.id), id = randomUUID();
    await d.run('INSERT INTO projects(id,owner,recipient,name,symbol,description,image,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', id, a.x_id, recipient.id, name, symbol, description, image.toString('base64'), Date.now());
    res.status(201).json({ id, name, symbol, creatorFeeRecipient: address, recipient });
  }));
  app.get('/api/metadata/:id', route(async (req, res) => {
    const d = await db(), p = await d.get('SELECT * FROM projects WHERE id=$1 AND frozen=1', req.params.id);
    if (!p) throw new AppError('Published token metadata not found.', 404);
    const a = await d.get('SELECT username FROM accounts WHERE x_id=$1', p.recipient);
    res.json({ name: p.name, symbol: p.symbol, description: `${p.description}\nCommunity support for X account ID ${p.recipient}. This is not a claim of endorsement by the beneficiary.`, image: `${origin(req)}/api/images/${p.id}`, external_url: `https://x.com/${a.username}`, attributes: [{ trait_type: 'Beneficiary X ID', value: p.recipient }] });
  }));
  app.get('/api/images/:id', route(async (req, res) => { const p = await (await db()).get('SELECT image FROM projects WHERE id=$1 AND frozen=1', req.params.id); if (!p) throw new AppError('Image not found.', 404); res.type('png').send(Buffer.from(p.image, 'base64')); }));
  app.post('/api/projects/:id/prepare', route(async (req, res) => { const a = await session(req); res.json(await prepareLaunch(await db(), a.x_id, req.params.id, origin(req))); }));
  app.post('/api/plans/:id/confirm', route(async (req, res) => { const a = await session(req); res.json(await confirmLaunch(await db(), a.x_id, req.params.id)); }));
  app.post('/api/plans/:id/check', route(async (req, res) => { const a = await session(req); res.json(await reconcile(await db(), a.x_id, req.params.id)); }));
  app.get('/api/launches', route(async (req, res) => { res.json(await (await db()).all("SELECT p.name,p.symbol,p.id,a.username,l.mint,l.signature,l.created FROM plans l JOIN projects p ON p.id=l.project_id JOIN accounts a ON a.x_id=p.recipient WHERE l.status='finalized' ORDER BY l.created DESC LIMIT 100")); }));
  const balanceCache = new Map();
  async function observed(address, force = false) {
    let entry = balanceCache.get(address);
    if (!entry || Date.now() - entry.checked > 60000 || force) { entry = await balances(address, options.read); balanceCache.set(address, entry); }
    return entry;
  }
  app.get('/api/balances/me', route(async (req, res) => { const a = await session(req), address = await collectorWallet(await db(), a.x_id); res.json(await observed(address)); }));
  app.get('/api/treasury', route(async (req, res) => res.json(await observed(project.treasury))));
  app.post('/api/claims', route(async (req, res) => { await session(req); throw new AppError('The private payout relay has not passed funded acceptance. No withdrawal was created and no funds moved.', 503); }));
  app.get('/api/nominations', route(async (req, res) => res.json(await (await db()).all('SELECT id,repo,name,description,reason,created FROM nominations ORDER BY created DESC LIMIT 50'))));
  app.post('/api/nominations', route(async (req, res) => {
    const a = await session(req), reason = text(req.body.reason, 'Reason', 30, 1000);
    let url; try { url = new URL(req.body.repo); } catch { throw new AppError('Enter the full GitHub repository URL.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) throw new AppError('Use a public github.com/owner/repository URL.');
    const parts = url.pathname.replace(/\/$/, '').slice(1);
    const r = await (options.fetcher || fetch)(`https://api.github.com/repos/${parts}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ZecPaid' }, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (!r.ok) throw new AppError('GitHub could not verify this public repository.', 502);
    const repo = await r.json();
    if (repo.private || repo.archived || repo.disabled || !repo.full_name) throw new AppError('Choose a public, unarchived repository.');
    const id = randomUUID();
    try { await (await db()).run('INSERT INTO nominations(id,owner,repo,name,description,reason,created) VALUES($1,$2,$3,$4,$5,$6,$7)', id, a.x_id, `https://github.com/${repo.full_name}`, repo.full_name, String(repo.description || '').slice(0, 500), reason, Date.now()); }
    catch (e) { if (e.code === '23505' || e.code === 'ERR_SQLITE_ERROR') throw new AppError('This repository has already been nominated.', 409); throw e; }
    res.status(201).json({ id, name: repo.full_name });
  }));
  app.use('/api', (_req, _res, next) => next(new AppError('API route not found.', 404)));
  app.use((e, _req, res, _next) => { const status = e.status || (e.type === 'entity.too.large' ? 413 : 500); if (status >= 500 && !e.status) console.error('ZecPaid request failed:', e.code || e.name); res.status(status).json({ error: e.status ? e.message : status === 413 ? 'This upload is too large.' : 'The service could not complete this request. Check the operator configuration.' }); });
  return app;
}
