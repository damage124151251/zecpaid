import { createRequire } from 'node:module';
import { randomUUID, verify, createPublicKey } from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { AppError, hash, unseal } from './security.mjs';
import { collectorWallet } from './accounts.mjs';
import { rpc } from './chain.mjs';
import config from '../shared/project.json' with { type: 'json' };
const require = createRequire(import.meta.url);
const { PumpSdk, OnlinePumpSdk } = require('@pump-fun/pump-sdk');
export function signingEnabled() { return process.env.ENABLE_LAUNCH === 'true'; }
export function validSignedMessage(base64, expectedHash) {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > 1232 || bytes.toString('base64') !== base64) throw new AppError('Unsupported transaction encoding.');
  const tx = VersionedTransaction.deserialize(bytes);
  if (hash(tx.message.serialize()) !== expectedHash || tx.message.header.numRequiredSignatures !== 2 || tx.signatures.length !== 2) throw new AppError('The transaction changed after review.', 409);
  for (let i = 0; i < 2; i++) {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), tx.message.staticAccountKeys[i].toBuffer()]), format: 'der', type: 'spki' });
    if (!verify(null, tx.message.serialize(), key, tx.signatures[i])) throw new AppError('A transaction signature is invalid.', 409);
  }
  return tx;
}
export async function prepareLaunch(db, owner, id, publicOrigin, read = rpc) {
  if (!signingEnabled()) throw new AppError('Token signing is waiting for funded acceptance testing and custody review. Nothing has been charged.', 503);
  if (!publicOrigin.startsWith('https://')) throw new AppError('Pump needs a public HTTPS metadata address.', 503);
  return db.tx(async () => {
    const p = await db.get('SELECT * FROM projects WHERE id=$1 AND owner=$2', id, owner);
    if (!p) throw new AppError('Project not found.', 404);
    if (await db.get("SELECT id FROM plans WHERE project_id=$1 AND status NOT IN ('failed','expired')", id)) throw new AppError('Check the existing launch before preparing another.', 409);
    if (await read('getGenesisHash', []) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new AppError('The RPC is not connected to Solana mainnet.', 503);
    const payer = await collectorWallet(db, owner), creator = await collectorWallet(db, p.recipient);
    const connection = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', { commitment: 'finalized', disableRetryOnRateLimit: true });
    const online = new OnlinePumpSdk(connection), sdk = new PumpSdk();
    const quote = await online.resolveQuoteMint(new PublicKey(config.zecMint));
    const mint = Keypair.generate();
    await db.run('UPDATE projects SET frozen=1 WHERE id=$1', id);
    const instruction = await sdk.createV2Instruction({ mint: mint.publicKey, name: p.name, symbol: p.symbol, uri: `${publicOrigin}/api/metadata/${id}`, creator: new PublicKey(creator), user: new PublicKey(payer), quoteMint: new PublicKey(config.zecMint), quoteTokenProgram: quote.quoteTokenProgram, mayhemMode: false, cashback: false, holderReward: false });
    const recent = await read('getLatestBlockhash', [{ commitment: 'finalized' }]);
    const legacy = new Transaction({ feePayer: new PublicKey(payer), blockhash: recent.value.blockhash, lastValidBlockHeight: recent.value.lastValidBlockHeight }).add(instruction);
    legacy.partialSign(mint);
    const tx = VersionedTransaction.deserialize(legacy.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const serialized = Buffer.from(tx.serialize()).toString('base64');
    if (tx.serialize().length > 1232 || tx.message.header.numRequiredSignatures !== 2) throw new AppError('This launch exceeds the supported transaction shape.', 409);
    const before = await read('getBalance', [payer, { commitment: 'finalized' }]);
    const sim = await read('simulateTransaction', [serialized, { encoding: 'base64', sigVerify: false, commitment: 'finalized', accounts: { encoding: 'base64', addresses: [payer] } }]);
    const after = sim.value.accounts?.[0]?.lamports;
    const fee = await read('getFeeForMessage', [Buffer.from(tx.message.serialize()).toString('base64'), { commitment: 'finalized' }]);
    const cost = before.value - after;
    if (sim.value.err || !Number.isSafeInteger(after) || !Number.isSafeInteger(cost) || cost < 0 || cost > 50000000 || !Number.isSafeInteger(fee.value) || fee.value < 0 || fee.value > 1000000) throw new AppError('Launch simulation did not pass the cost limits. Check the funding wallet\'s SOL balance.', 409);
    const planId = randomUUID(), expires = Date.now() + 75000;
    const account = await db.get('SELECT username FROM accounts WHERE x_id=$1', p.recipient);
    const review = { name: p.name, symbol: p.symbol, recipientId: p.recipient, recipientUsername: account.username, creatorFeeRecipient: creator, payer, quote: 'ZEC', quoteMint: config.zecMint, initialBuy: false, simulatedCostLamports: String(cost), networkFeeLamports: String(fee.value), publicLaunch: true };
    await db.run('INSERT INTO plans(id,project_id,owner,serialized,message_hash,mint,last_height,review,status,expires,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', planId, id, owner, serialized, hash(tx.message.serialize()), mint.publicKey.toBase58(), recent.value.lastValidBlockHeight, JSON.stringify(review), 'prepared', expires, Date.now());
    return { id: planId, review, expires, mint: mint.publicKey.toBase58(), status: 'prepared' };
  });
}
export async function confirmLaunch(db, owner, id, read = rpc) {
  if (!signingEnabled()) throw new AppError('Token signing is not enabled.', 503);
  // Persist the signed bytes and signature before the network can receive them.
  const plan = await db.tx(async () => {
    const p = await db.get('SELECT * FROM plans WHERE id=$1 AND owner=$2', id, owner);
    if (!p) throw new AppError('Launch not found.', 404);
    if (p.status !== 'prepared') return p;
    if (Number(p.expires) < Date.now()) { await db.run("UPDATE plans SET status='expired' WHERE id=$1", id); return { ...p, status: 'expired' }; }
    const review = JSON.parse(p.review), wallet = await db.get('SELECT * FROM wallets WHERE x_id=$1', owner);
    if (wallet.address !== review.payer) throw new AppError('Funding wallet mismatch.', 409);
    const secret = unseal(wallet.secret, `wallet:${owner}:${wallet.address}`);
    let tx;
    try { const pair = Keypair.fromSecretKey(secret); tx = VersionedTransaction.deserialize(Buffer.from(p.serialized, 'base64')); tx.sign([pair]); pair.secretKey.fill(0); } finally { secret.fill(0); }
    const signed = Buffer.from(tx.serialize()).toString('base64');
    validSignedMessage(signed, p.message_hash);
    const signature = bs58.encode(tx.signatures[0]);
    await db.run("UPDATE plans SET signed=$1,signature=$2,status='pending' WHERE id=$3", signed, signature, id);
    return { ...p, signed, signature, status: 'send_once' };
  });
  if (plan.status === 'expired') throw new AppError('This launch review expired. Prepare a new transaction.', 409);
  if (plan.status === 'send_once') {
    try { const signature = await read('sendTransaction', [plan.signed, { encoding: 'base64', skipPreflight: false, maxRetries: 0, preflightCommitment: 'finalized' }]); if (signature !== plan.signature) throw Error('Signature mismatch'); }
    catch { return { id, status: 'pending', signature: plan.signature, message: 'The broadcast result is uncertain. Check this receipt; do not pay again.' }; }
  }
  return reconcile(db, owner, id, read);
}
export async function reconcile(db, owner, id, read = rpc) {
  const p = await db.get('SELECT * FROM plans WHERE id=$1 AND owner=$2', id, owner);
  if (!p) throw new AppError('Launch not found.', 404);
  if (!p.signature || ['finalized', 'failed', 'expired'].includes(p.status)) return { id, status: p.status, signature: p.signature, mint: p.mint };
  const receipt = await read('getTransaction', [p.signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 0 }]);
  if (receipt) {
    if (!receipt.transaction?.[0]) throw new AppError('The finalized receipt did not contain transaction bytes.', 502);
    const tx = validSignedMessage(receipt.transaction[0], p.message_hash);
    if (bs58.encode(tx.signatures[0]) !== p.signature) throw new AppError('Finalized receipt signature mismatch.', 409);
    await db.run('UPDATE plans SET status=$1 WHERE id=$2', receipt.meta?.err ? 'failed' : 'finalized', id);
    return { id, status: receipt.meta?.err ? 'failed' : 'finalized', signature: p.signature, mint: p.mint };
  }
  const height = await read('getBlockHeight', [{ commitment: 'finalized' }]);
  if (Number.isSafeInteger(height) && height > Number(p.last_height)) {
    const status = await read('getSignatureStatuses', [[p.signature], { searchTransactionHistory: true }]);
    if (!status.value?.[0]) {
      const account = await read('getAccountInfo', [p.mint, { commitment: 'finalized', encoding: 'base64' }]);
      if (!account.value) await db.run("UPDATE plans SET status='expired' WHERE id=$1", id);
    }
  }
  return { id, status: (await db.get('SELECT status FROM plans WHERE id=$1', id)).status, signature: p.signature, mint: p.mint };
}
