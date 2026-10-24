import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Keypair, Transaction, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import sharp from 'sharp';
import { openDatabase } from '../server/db.mjs';
import { createApp } from '../server/app.mjs';
import { collectorWallet, rememberAccount, normalizeAccount } from '../server/accounts.mjs';
import { seal, unseal, hash, pkce } from '../server/security.mjs';
import { balances } from '../server/chain.mjs';
import { validSignedMessage, prepareLaunch, confirmLaunch, reconcile } from '../server/launches.mjs';
import project from '../shared/project.json' with { type: 'json' };

test('account-bound authenticated encryption rejects a different account and tampering', () => {
  const key = randomBytes(32).toString('base64'), value = seal(Buffer.from('private'), 'wallet:1:A', key);
  assert.equal(unseal(value, 'wallet:1:A', key).toString(), 'private');
  assert.throws(() => unseal(value, 'wallet:2:A', key));
  assert.throws(() => unseal(value.replace(/.$/, value.endsWith('a') ? 'b' : 'a'), 'wallet:1:A', key));
});
test('PKCE uses SHA256 base64url', () => assert.equal(pkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'));
test('X identity normalization requires the permanent numeric ID', () => {
  assert.throws(() => normalizeAccount({ data: { id: 'not-an-id', username: 'dev', name: 'Dev' } }));
  assert.equal(normalizeAccount({ data: { id: '123', username: 'dev', name: 'Dev', profile_image_url: 'javascript:alert(1)' } }).avatar, null);
});
test('one encrypted collector wallet per account, including concurrent creation and rename', async () => {
  const db = await openDatabase(':memory:'), key = randomBytes(32).toString('base64');
  try {
    await rememberAccount(db, { id: '123', username: 'before', name: 'Builder', avatar: null });
    const addresses = await Promise.all(Array.from({ length: 6 }, () => collectorWallet(db, '123', key)));
    assert.equal(new Set(addresses).size, 1);
    await rememberAccount(db, { id: '123', username: 'after', name: 'Builder', avatar: null });
    assert.equal(await collectorWallet(db, '123', key), addresses[0]);
    const stored = await db.get('SELECT * FROM wallets WHERE x_id=$1', '123');
    const secret = unseal(stored.secret, `wallet:123:${stored.address}`, key);
    assert.equal(Keypair.fromSecretKey(secret).publicKey.toBase58(), stored.address);
    assert.equal((await db.all('SELECT * FROM wallets')).length, 1);
  } finally { await db.close(); }
});
test('wallet cannot be created for an unverified username or unknown ID', async () => {
  const db = await openDatabase(':memory:');
  try { await assert.rejects(collectorWallet(db, 'dev'), /verified/); await assert.rejects(collectorWallet(db, '999'), /Resolve/); }
  finally { await db.close(); }
});
test('balance observations aggregate exact raw ZEC amounts and reject a wrong mint', async () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const read = async method => method === 'getBalance' ? { value: 123456 } : { value: ['9007199254740993', '7'].map(amount => ({ account: { data: { parsed: { info: { owner, mint: project.zecMint, tokenAmount: { amount, decimals: 8 } } } } } })) };
  assert.equal((await balances(owner, read)).zecRaw, '9007199254741000');
  await assert.rejects(balances(owner, async method => method === 'getBalance' ? { value: 0 } : { value: [{ account: { data: { parsed: { info: { owner, mint: 'fake' } } } } }] }), /unsupported/);
});
test('two exact signatures are required; message changes are rejected', () => {
  const a = Keypair.generate(), b = Keypair.generate();
  const legacy = new Transaction({ feePayer: a.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(SystemProgram.transfer({ fromPubkey: b.publicKey, toPubkey: a.publicKey, lamports: 1 }));
  legacy.sign(a, b);
  const tx = VersionedTransaction.deserialize(legacy.serialize()), encoded = Buffer.from(tx.serialize()).toString('base64'), expected = hash(tx.message.serialize());
  assert.equal(validSignedMessage(encoded, expected).signatures.length, 2);
  assert.throws(() => validSignedMessage(encoded, 'different'), /changed/);
  tx.signatures[1].fill(0);
  assert.throws(() => validSignedMessage(Buffer.from(tx.serialize()).toString('base64'), expected), /signature/);
});
test('financial launch signing is closed by default', async () => {
  const previous = process.env.ENABLE_LAUNCH; delete process.env.ENABLE_LAUNCH;
  try { await assert.rejects(prepareLaunch(null, '1', 'id', 'https://example.com'), /funded acceptance/); await assert.rejects(confirmLaunch(null, '1', 'id'), /not enabled/); }
  finally { if (previous !== undefined) process.env.ENABLE_LAUNCH = previous; }
});

test('real HTTP OAuth, browser binding, replay protection, persistence and authorization with explicit X fixtures', async t => {
  const keys = ['PUBLIC_URL','CUSTODY_ENCRYPTION_KEY','X_CLIENT_ID','X_CLIENT_SECRET','X_BEARER_TOKEN','ENABLE_LAUNCH'];
  const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.PUBLIC_URL = 'http://127.0.0.1:5278'; process.env.CUSTODY_ENCRYPTION_KEY = randomBytes(32).toString('base64'); process.env.X_CLIENT_ID = 'test-client'; process.env.X_CLIENT_SECRET = 'test-secret'; process.env.X_BEARER_TOKEN = 'test-bearer'; delete process.env.ENABLE_LAUNCH;
  const db = await openDatabase(':memory:');
  let subject = { id: '123', username: 'builder', name: 'Builder', avatar: null }, changed = false;
  const provider = { exchange: async (_code, verifier) => { assert.ok(verifier.length > 30); return 'fixture-token'; }, me: async () => subject, lookup: async username => ({ id: changed ? '999' : '456', username, name: 'Recipient', avatar: null }) };
  const app = createApp({ database: db, provider, read: async method => method === 'getBalance' ? { value: 0 } : { value: [] }, fetcher: async () => new Response(JSON.stringify({ full_name: 'owner/repo', private: false, archived: false, disabled: false, description: 'Actual test fixture.' }), { status: 200 }) });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  process.env.PUBLIC_URL = base.slice(0, -4);
  const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
  let sid;
  async function login() {
    const start = await request('/auth/start'), u = new URL(start.headers.get('location'));
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    const bound = start.headers.get('set-cookie').split(';')[0];
    const callback = `/auth/callback?code=fixture&state=${u.searchParams.get('state')}`;
    assert.equal((await request(callback)).status, 403);
    const result = await request(callback, { headers: { cookie: bound } });
    assert.equal(result.status, 302);
    sid = result.headers.getSetCookie().find(c => c.startsWith('zp_session=')).split(';')[0];
    assert.equal((await request(callback, { headers: { cookie: bound } })).status, 403);
  }
  const send = (path, body, headers = {}) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: process.env.PUBLIC_URL, cookie: sid, ...headers }, body: JSON.stringify(body) });
  try {
    await t.test('OAuth uses a browser-bound single-use state and never exposes private keys', async () => { await login(); const body = await (await request('/me', { headers: { cookie: sid } })).json(); assert.equal(body.id, '123'); assert.ok(body.wallet); assert.ok(!JSON.stringify(body).includes('secret')); });
    await t.test('cross-origin requests are rejected', async () => assert.equal((await send('/projects', {}, { Origin: 'https://evil.example' })).status, 403));
    let projectId;
    const image = `data:image/png;base64,${(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f4b728' } }).png().toBuffer()).toString('base64')}`;
    const input = { username: 'recipient', recipientId: '456', name: 'Support', symbol: 'DEV', description: 'A test project, not a real launch.', image };
    await t.test('saved project rechecks X identity and persists', async () => {
      const r = await send('/projects', input); assert.equal(r.status, 201); const p = await r.json(); projectId = p.id;
      const projects = await (await request('/projects', { headers: { cookie: sid } })).json(); assert.equal(projects[0].name, 'Support');
      assert.equal((await request(`/metadata/${projectId}`)).status, 404);
    });
    await t.test('a recycled handle cannot change the beneficiary', async () => { changed = true; assert.equal((await send('/projects', input)).status, 409); changed = false; });
    await t.test('unfunded release cannot claim, launch, or publish fake registry records', async () => {
      assert.equal((await send(`/projects/${projectId}/prepare`)).status, 503);
      assert.equal((await send('/claims', { destination: Keypair.generate().publicKey.toBase58() })).status, 503);
      assert.deepEqual(await (await request('/launches')).json(), []);
    });
    await t.test('nominations validate GitHub URL before any fetch', async () => {
      assert.equal((await send('/nominations', { repo: 'http://127.0.0.1:9000/private', reason: 'A long explanation for this specific nomination.' })).status, 400);
      assert.equal((await send('/nominations', { repo: 'https://github.com/owner/repo', reason: 'A long explanation for this specific nomination.' })).status, 201);
    });
    await t.test('a second X account cannot list the first account projects', async () => { subject = { id: '789', username: 'second', name: 'Second', avatar: null }; await login(); assert.deepEqual(await (await request('/projects', { headers: { cookie: sid } })).json(), []); });
    await t.test('missing X registration is surfaced explicitly, not a fake login', async () => { delete process.env.X_CLIENT_ID; const r = await request('/auth/start'); assert.equal(r.status, 503); assert.match((await r.json()).error, /register/); });
  } finally {
    await new Promise(resolve => server.close(resolve)); await db.close();
    for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; }
  }
});

test('uncertain broadcast is reconciled against stored signature, not paid again', async () => {
  const db = await openDatabase(':memory:');
  try {
    await db.run('INSERT INTO plans(id,project_id,owner,serialized,message_hash,mint,last_height,review,status,signature,expires,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', 'plan', 'project', '1', '', 'hash', 'mint', 100, '{}', 'pending', 'signature', 0, Date.now());
    const methods = [];
    const read = async method => { methods.push(method); return method === 'getTransaction' ? null : 90; };
    assert.equal((await reconcile(db, '1', 'plan', read)).status, 'pending');
    assert.deepEqual(methods, ['getTransaction', 'getBlockHeight']);
  } finally { await db.close(); }
});
