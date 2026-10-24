import { createPublicKey, verify, randomUUID } from 'node:crypto';
import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AppError, hash, unseal } from './security.mjs';
import { rpc } from './chain.mjs';
import project from '../shared/project.json' with { type: 'json' };

export const moneyEnabled = () => process.env.MONEY_EXECUTION_ENABLED === 'reviewed-and-funded';
export function requireMoney(owner) {
  if (!moneyEnabled() || process.env.FINANCE_TEST_X_ID && process.env.FINANCE_TEST_X_ID !== owner) throw new AppError('Financial execution needs a reviewed, funded acceptance test. Nothing was signed or sent.', 503);
}
export async function mainnet(read = rpc) { if (await read('getGenesisHash', []) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new AppError('A verified Solana mainnet RPC is required.', 503); }
export function signedTransaction(encoded, expectedHash, wallet, count = 1) {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > 1232 || bytes.toString('base64') !== encoded) throw new AppError('Invalid transaction encoding.');
  const tx = VersionedTransaction.deserialize(bytes), message = tx.message.serialize();
  if (hash(message) !== expectedHash || tx.message.header.numRequiredSignatures !== count || tx.signatures.length !== count || tx.message.staticAccountKeys[0].toBase58() !== wallet) throw new AppError('Transaction does not match the approved wallet and message.', 409);
  for (let i = 0; i < count; i++) {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),tx.message.staticAccountKeys[i].toBuffer()]), format: 'der', type: 'spki' });
    if (!verify(null,message,key,tx.signatures[i])) throw new AppError('Invalid transaction signature.',409);
  }
  return tx;
}
export async function walletPair(db, owner) {
  const w = await db.get('SELECT * FROM wallets WHERE x_id=$1',owner);
  if (!w) throw new AppError('Your managed wallet has not been created by a verified X login.',409);
  const bytes = unseal(w.secret,`wallet:${owner}:${w.address}`);
  try { const pair = Keypair.fromSecretKey(Uint8Array.from(bytes)); if (pair.publicKey.toBase58() !== w.address) throw new AppError('Managed wallet binding mismatch.',409); return pair; } finally { bytes.fill(0); }
}
export function tokenAmount(account, mint, owner) {
  if (!account) return 0n;
  if (account.owner !== TOKEN_PROGRAM_ID.toBase58() || !Array.isArray(account.data)) throw new AppError('Unsupported token account.',409);
  const data = Buffer.from(account.data[0],'base64');
  if (data.length < 165 || !data.subarray(0,32).equals(new PublicKey(mint).toBuffer()) || !data.subarray(32,64).equals(new PublicKey(owner).toBuffer())) throw new AppError('Token account mint or owner mismatch.',409);
  return data.readBigUInt64LE(64);
}
export async function prepareTransaction(wallet, instructions, read = rpc, maxCost = 5000000) {
  const recent = await read('getLatestBlockhash',[{commitment:'finalized'}]);
  const legacy = new Transaction({feePayer:new PublicKey(wallet),blockhash:recent.value.blockhash,lastValidBlockHeight:recent.value.lastValidBlockHeight}).add(...instructions);
  const tx = VersionedTransaction.deserialize(legacy.serialize({requireAllSignatures:false,verifySignatures:false}));
  if (tx.serialize().length > 1232 || tx.message.header.numRequiredSignatures !== 1) throw new AppError('This fee collection must be split into smaller reviewed transactions.',409);
  const serialized = Buffer.from(tx.serialize()).toString('base64');
  const ata = getAssociatedTokenAddressSync(new PublicKey(project.zecMint),new PublicKey(wallet)).toBase58();
  const before = await read('getMultipleAccounts',[ [wallet,ata],{commitment:'finalized',encoding:'base64'}]);
  const sim = await read('simulateTransaction',[serialized,{encoding:'base64',commitment:'finalized',sigVerify:false,accounts:{encoding:'base64',addresses:[wallet,ata]}}]);
  if (sim.value.err) throw new AppError('Simulation failed. Check the SOL funding balance and current fee accounts.',409);
  const oldSol=before.value?.[0]?.lamports,newSol=sim.value.accounts?.[0]?.lamports,cost=oldSol-newSol;
  if (!Number.isSafeInteger(oldSol)||!Number.isSafeInteger(newSol)||!Number.isSafeInteger(cost)||cost<0||cost>maxCost) throw new AppError('The simulated SOL cost exceeds the approved limit.',409);
  const gain=tokenAmount(sim.value.accounts[1],project.zecMint,wallet)-tokenAmount(before.value[1],project.zecMint,wallet);
  if (gain<=0n) throw new AppError('No collectible ZEC was found in this transaction. Nothing was signed.',409);
  return {serialized,messageHash:hash(tx.message.serialize()),lastHeight:recent.value.lastValidBlockHeight,costLamports:String(cost),expectedZecRaw:String(gain)};
}
export async function operation(db, owner, id) {
  const row=await db.get('SELECT * FROM money_operations WHERE id=$1 AND owner=$2',id,owner);
  if(!row)throw new AppError('Operation not found.',404);
  return row;
}
export function publicOperation(row) { return {id:row.id,kind:row.kind,status:row.status,review:JSON.parse(row.review),signature:row.signature,withdrawalSignature:row.withdrawal_signature,error:row.error,result:row.result?JSON.parse(row.result):null,created:Number(row.created),updated:Number(row.updated),expires:Number(row.expires)}; }
export async function createOperation(db, owner, kind, subject, review, extra={}) {
  const id=randomUUID(),now=Date.now();
  await db.run('INSERT INTO money_operations(id,owner,kind,subject,status,review,serialized,message_hash,last_height,expires,created,updated) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',id,owner,kind,subject,'quoted',JSON.stringify(review),extra.serialized||null,extra.messageHash||null,extra.lastHeight||null,now+180000,now,now);
  return publicOperation(await operation(db,owner,id));
}
export async function confirmFeeOperation(db,owner,id,read=rpc) {
  requireMoney(owner);
  const record=await db.tx(async()=>{
    const row=await operation(db,owner,id);
    if(row.kind!=='fees')throw new AppError('Wrong operation type.',409);
    if(row.status!=='quoted')return row;
    if(Number(row.expires)<Date.now())throw new AppError('Fee review expired. Prepare a fresh quote.',409);
    const active=await db.get("SELECT id FROM money_operations WHERE owner=$1 AND id<>$2 AND status NOT IN ('quoted','finalized','failed','expired','cancelled')",owner,id);
    if(active)throw new AppError('Another operation for this wallet needs reconciliation first.',409);
    const review=JSON.parse(row.review),pair=await walletPair(db,owner);
    const tx=VersionedTransaction.deserialize(Buffer.from(row.serialized,'base64'));
    if(hash(tx.message.serialize())!==row.message_hash||tx.message.staticAccountKeys[0].toBase58()!==pair.publicKey.toBase58())throw new AppError('Fee transaction changed after review.',409);
    tx.sign([pair]);const signed=Buffer.from(tx.serialize()).toString('base64');signedTransaction(signed,row.message_hash,review.wallet);
    const signature=bs58.encode(tx.signatures[0]);
    await db.run("UPDATE money_operations SET signed=$1,signature=$2,status='pending',updated=$3 WHERE id=$4",signed,signature,Date.now(),id);
    return {...row,signed,signature,status:'send_once'};
  });
  if(record.status==='send_once'){
    try{const value=await read('sendTransaction',[record.signed,{encoding:'base64',skipPreflight:false,maxRetries:0,preflightCommitment:'finalized'}]);if(value!==record.signature)throw Error();}
    catch{await db.run('UPDATE money_operations SET error=$1,updated=$2 WHERE id=$3','Broadcast response uncertain. Reconcile this operation before another attempt.',Date.now(),id);return publicOperation(await operation(db,owner,id));}
  }
  return reconcileFeeOperation(db,owner,id,read);
}
export async function reconcileFeeOperation(db,owner,id,read=rpc) {
  const row=await operation(db,owner,id);
  if(row.kind!=='fees'||!row.signature||['finalized','failed','expired'].includes(row.status))return publicOperation(row);
  const receipt=await read('getTransaction',[row.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
  if(receipt){
    const review=JSON.parse(row.review),tx=signedTransaction(receipt.transaction[0],row.message_hash,review.wallet);
    if(bs58.encode(tx.signatures[0])!==row.signature||!receipt.meta)throw new AppError('Fee receipt mismatch.',409);
    let received=0n;
    if(!receipt.meta.err){const keys=tx.message.staticAccountKeys.map(k=>k.toBase58()),ata=getAssociatedTokenAddressSync(new PublicKey(project.zecMint),new PublicKey(review.wallet)).toBase58(),index=keys.indexOf(ata);const matching=b=>b.accountIndex===index&&b.mint===project.zecMint&&b.owner===review.wallet&&b.uiTokenAmount?.decimals===8;const pre=receipt.meta.preTokenBalances?.find(matching),post=receipt.meta.postTokenBalances?.find(matching);if(index<0||!post)throw new AppError('The exact beneficiary ZEC receipt could not be verified.',409);received=BigInt(post.uiTokenAmount.amount)-BigInt(pre?.uiTokenAmount.amount||'0');if(received<0n)throw new AppError('Unexpected fee-wallet outflow.',409);}
    await db.run('UPDATE money_operations SET status=$1,result=$2,error=NULL,updated=$3 WHERE id=$4',receipt.meta.err?'failed':'finalized',JSON.stringify({signature:row.signature,slot:receipt.slot,receivedZecRaw:String(received)}),Date.now(),id);
  }else{
    const height=await read('getBlockHeight',[{commitment:'finalized'}]);
    if(Number.isSafeInteger(height)&&height>Number(row.last_height)){const s=await read('getSignatureStatuses',[[row.signature],{searchTransactionHistory:true}]);if(!s.value?.[0])await db.run("UPDATE money_operations SET status='expired',updated=$1 WHERE id=$2",Date.now(),id);}
  }
  return publicOperation(await operation(db,owner,id));
}
