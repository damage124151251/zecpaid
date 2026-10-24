import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {Keypair,PublicKey,Transaction,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import bs58 from 'bs58';
import * as borsh from 'borsh';
import {openDatabase} from '../server/db.mjs';
import {rememberAccount,collectorWallet} from '../server/accounts.mjs';
import {hash} from '../server/security.mjs';
import {createOperation,operation,signedTransaction,confirmFeeOperation,reconcileFeeOperation,requireMoney,tokenAmount} from '../server/money.mjs';
import {parseZec,privateQuote,approveClaim,commitWithdrawal,cancelClaim,reconcileClaim} from '../server/privacy.mjs';
import {proofSchema,discriminator,proofAccounts,validateWithdrawal,withdrawalReceipt} from '../server/private-proofs.mjs';
import project from '../shared/project.json' with {type:'json'};
import rail from '../shared/privacy.json' with {type:'json'};

process.env.CUSTODY_ENCRYPTION_KEY=randomBytes(32).toString('base64');
const owner='123',other='456';
async function fixture(fn){
  const db=await openDatabase(':memory:');
  const old=process.env.MONEY_EXECUTION_ENABLED;process.env.MONEY_EXECUTION_ENABLED='reviewed-and-funded';
  try{await rememberAccount(db,{id:owner,username:'fixture',name:'Fixture',avatar:null});const wallet=await collectorWallet(db,owner);await fn(db,wallet);}
  finally{if(old===undefined)delete process.env.MONEY_EXECUTION_ENABLED;else process.env.MONEY_EXECUTION_ENABLED=old;await db.close();}
}
function feeTransaction(wallet){
  const tx=VersionedTransaction.deserialize(new Transaction({feePayer:new PublicKey(wallet),recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(SystemProgram.transfer({fromPubkey:new PublicKey(wallet),toPubkey:getAssociatedTokenAddressSync(new PublicKey(project.zecMint),new PublicKey(wallet)),lamports:1})).serialize({requireAllSignatures:false,verifySignatures:false}));
  return {serialized:Buffer.from(tx.serialize()).toString('base64'),messageHash:hash(tx.message.serialize()),lastHeight:100};
}
function withdrawalFixture(){
  const destination=Keypair.generate().publicKey.toBase58(),review={destination,netRaw:'1000000',providerFeeRaw:'54500',grossRaw:'1054500'};
  const bytes=n=>[...randomBytes(n)],field=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const proof={a:bytes(64),b:bytes(128),c:bytes(64),root:bytes(32),publicAmount:[...Buffer.from((field-BigInt(review.grossRaw)).toString(16).padStart(64,'0'),'hex')],extHash:Array(32).fill(0),null0:bytes(32),null1:bytes(32),commit0:bytes(32),commit1:bytes(32),extAmount:-1000000n,fee:54500n,encrypted0:bytes(64),encrypted1:bytes(64)};
  const accounts=proofAccounts(proof,destination),array=len=>({array:{type:'u8',len}}),vector={array:{type:'u8'}};
  const schema={struct:{recipient:array(32),extAmount:'i64',encrypted0:vector,encrypted1:vector,fee:'u64',feeRecipient:array(32),mint:array(32)}};
  const encoded=borsh.serialize(schema,{recipient:[...new PublicKey(accounts.recipientAta).toBytes()],extAmount:proof.extAmount,encrypted0:proof.encrypted0,encrypted1:proof.encrypted1,fee:proof.fee,feeRecipient:[...new PublicKey(accounts.feeRecipientTokenAccount).toBytes()],mint:[...new PublicKey(project.zecMint).toBytes()]});
  const digest=createHash('sha256').update(encoded).digest().reverse();
  proof.extHash=[...Buffer.from((BigInt('0x'+digest.toString('hex'))%field).toString(16).padStart(64,'0'),'hex')];
  const data=Buffer.concat([discriminator,Buffer.from(borsh.serialize(proofSchema,proof))]);
  return {review,body:{...accounts,serializedProof:data.toString('base64'),extAmount:-1000000,fee:54500},data};
}

test('financial flag is exact and optional test-account restriction cannot be bypassed',()=>{
  const old=process.env.MONEY_EXECUTION_ENABLED;
  try{process.env.MONEY_EXECUTION_ENABLED='true';assert.throws(()=>requireMoney(owner));process.env.MONEY_EXECUTION_ENABLED='reviewed-and-funded';process.env.FINANCE_TEST_X_ID=owner;requireMoney(owner);assert.throws(()=>requireMoney(other));}
  finally{delete process.env.FINANCE_TEST_X_ID;if(old===undefined)delete process.env.MONEY_EXECUTION_ENABLED;else process.env.MONEY_EXECUTION_ENABLED=old;}
});
test('ZEC quotes preserve exact net units and reject unsafe amounts or changed provider policies',()=>{
  assert.equal(parseZec('0.01000001'),1000001n);
  for(const value of ['0','-1','1e-2','0.000000001','2','NaN'])assert.throws(()=>parseZec(value));
  const config={withdraw_fee_rate:.0035,rent_fees:{zec:.00051},minimum_withdrawal:{zec:.01}},q=privateQuote(1000000n,config);
  assert.equal(BigInt(q.netRaw)+BigInt(q.providerFeeRaw),BigInt(q.grossRaw));
  assert.equal(Number(q.grossRaw)-Math.floor(Number(q.grossRaw)*.0035+51000),1000000);
  assert.throws(()=>privateQuote(999999n,config),/at least/);
  assert.throws(()=>privateQuote(1000000n,{...config,withdraw_fee_rate:.2}),/limits/);
});
test('SPL parsing rejects wrong mint, owner and token program',()=>{
  const wallet=Keypair.generate().publicKey.toBase58(),data=Buffer.alloc(165);new PublicKey(project.zecMint).toBuffer().copy(data);new PublicKey(wallet).toBuffer().copy(data,32);data.writeBigUInt64LE(9007199254740993n,64);
  const account={owner:TOKEN_PROGRAM_ID.toBase58(),data:[data.toString('base64'),'base64']};
  assert.equal(tokenAmount(account,project.zecMint,wallet),9007199254740993n);
  assert.throws(()=>tokenAmount(account,project.zecMint,Keypair.generate().publicKey.toBase58()));
  assert.throws(()=>tokenAmount({...account,owner:SystemProgram.programId.toBase58()},project.zecMint,wallet));
});
test('changed messages and missing signatures cannot enter the managed money path',()=>{
  const wallet=Keypair.generate(),prepared=feeTransaction(wallet.publicKey.toBase58()),tx=VersionedTransaction.deserialize(Buffer.from(prepared.serialized,'base64'));tx.sign([wallet]);const encoded=Buffer.from(tx.serialize()).toString('base64');
  signedTransaction(encoded,prepared.messageHash,wallet.publicKey.toBase58());
  assert.throws(()=>signedTransaction(encoded,'different',wallet.publicKey.toBase58()));
  assert.throws(()=>signedTransaction(prepared.serialized,prepared.messageHash,wallet.publicKey.toBase58()));
});
test('ambiguous fee broadcast is persisted and never resubmitted; only a matching finalized receipt completes it',async()=>fixture(async(db,wallet)=>{
  const plan=await createOperation(db,owner,'fees','fixture',{wallet},feeTransaction(wallet));let sends=0;
  const read=async method=>{if(method==='sendTransaction'){sends++;throw Error('lost response');}if(method==='getTransaction')return null;if(method==='getBlockHeight')return 50;throw Error(method);};
  assert.equal((await confirmFeeOperation(db,owner,plan.id,read)).status,'pending');
  const row=await operation(db,owner,plan.id);assert.ok(row.signed&&row.signature);
  await confirmFeeOperation(db,owner,plan.id,read);assert.equal(sends,1);
  await assert.rejects(operation(db,other,plan.id),/not found/);
  const tx=VersionedTransaction.deserialize(Buffer.from(row.signed,'base64')),ata=getAssociatedTokenAddressSync(new PublicKey(project.zecMint),new PublicKey(wallet));
  // The first receipt is cryptographically matching but has no ZEC account delta.
  await assert.rejects(reconcileFeeOperation(db,owner,plan.id,async()=>({transaction:[row.signed,'base64'],slot:88,meta:{err:null,preTokenBalances:[],postTokenBalances:[]}})),/receipt could not/);
  assert.equal((await operation(db,owner,plan.id)).status,'pending');
  const index=tx.message.staticAccountKeys.findIndex(k=>k.equals(ata)),balance=amount=>({accountIndex:index,mint:project.zecMint,owner:wallet,uiTokenAmount:{amount,decimals:8}});
  const receipt={transaction:[row.signed,'base64'],slot:88,meta:{err:null,preTokenBalances:[balance('50')],postTokenBalances:[balance('150')]}};
  assert.equal((await reconcileFeeOperation(db,owner,plan.id,async()=>receipt)).result.receivedZecRaw,'100');
}));
test('a wallet cannot approve a second fee operation or claim while a fee send is pending',async()=>fixture(async(db,wallet)=>{
  const a=await createOperation(db,owner,'fees','a',{wallet},feeTransaction(wallet)),b=await createOperation(db,owner,'fees','b',{wallet},feeTransaction(wallet));
  await db.run("UPDATE money_operations SET status='pending' WHERE id=$1",a.id);
  await assert.rejects(confirmFeeOperation(db,owner,b.id),/reconciliation/);
  const claim=await createOperation(db,owner,'private_claim','d',{wallet,needsFunding:false});
  await assert.rejects(approveClaim(db,owner,claim.id,async()=>assert.fail('must not execute')),/reconciliation/);
}));
test('private proofs bind the exact recipient, mint, provider, net and fee; partial withdrawal is rejected',()=>{
  const f=withdrawalFixture();assert.equal(validateWithdrawal(f.review,f.body).proofHash,hash(f.data));
  for(const change of [{recipient:Keypair.generate().publicKey.toBase58()},{mintAddress:SystemProgram.programId.toBase58()},{feeRecipientAccount:SystemProgram.programId.toBase58()},{extAmount:-999999},{fee:1},{referralId:'unexpected'}])assert.throws(()=>validateWithdrawal(f.review,{...f.body,...change}));
  assert.throws(()=>validateWithdrawal({...f.review,destination:Keypair.generate().publicKey.toBase58()},f.body));
  const bytes=Buffer.from(f.data);bytes[bytes.length-1]^=1;assert.throws(()=>validateWithdrawal(f.review,{...f.body,serializedProof:bytes.toString('base64')}));
});
test('receipt verification requires the committed proof and exact successful recipient delta',()=>{
  const f=withdrawalFixture(),signature=bs58.encode(randomBytes(64)),receipt={slot:90,transaction:{signatures:[signature],message:{accountKeys:[{pubkey:f.body.recipientAta}],instructions:[{programId:rail.program,data:bs58.encode(f.data),accounts:[]}] }},meta:{err:null,preTokenBalances:[],postTokenBalances:[{accountIndex:0,mint:project.zecMint,owner:f.review.destination,uiTokenAmount:{decimals:8,amount:f.review.netRaw}}]}};
  receipt.transaction.message.instructions[0].accounts=[f.body.recipientAta,f.body.mintAddress,f.body.feeRecipientTokenAccount,f.body.treeAccount,f.body.nullifier0PDA,f.body.nullifier1PDA];
  assert.equal(withdrawalReceipt(f.review,hash(f.data),f.body,receipt).signature,signature);
  assert.throws(()=>withdrawalReceipt(f.review,'wrong',f.body,receipt));
  receipt.meta.postTokenBalances[0].uiTokenAmount.amount='999999';assert.throws(()=>withdrawalReceipt(f.review,hash(f.data),f.body,receipt));
  receipt.meta.err={InstructionError:[0,'Custom']};assert.throws(()=>withdrawalReceipt(f.review,hash(f.data),f.body,receipt));
});
test('withdrawal proof is durably committed once and cannot be cancelled or replayed',async()=>fixture(async(db,wallet)=>{
  const f=withdrawalFixture(),p=await createOperation(db,owner,'private_claim',f.review.destination,{...f.review,wallet});
  await db.run("UPDATE money_operations SET status='approved' WHERE id=$1",p.id);
  await commitWithdrawal(db,owner,p.id,f.body);const row=await operation(db,owner,p.id);assert.equal(row.status,'withdraw_pending');assert.ok(row.proof_data&&!row.proof_data.includes(f.body.serializedProof));
  await assert.rejects(commitWithdrawal(db,owner,p.id,f.body),/cannot submit/);await assert.rejects(cancelClaim(db,owner,p.id),/in flight/);
}));
test('an absent deposit expires only when the chain confirms blockhash expiry and no signature history',async()=>fixture(async(db,wallet)=>{
  const p=await createOperation(db,owner,'private_claim','destination',{wallet,depositRaw:'100'}),signature=bs58.encode(randomBytes(64));
  await db.run("UPDATE money_operations SET status='deposit_pending',signature=$1,result=$2 WHERE id=$3",signature,JSON.stringify({depositBlockhash:Keypair.generate().publicKey.toBase58()}),p.id);
  const read=async method=>method==='getTransaction'?null:method==='isBlockhashValid'?{value:false}:{value:[null]};
  assert.equal((await reconcileClaim(db,owner,p.id,read)).status,'expired');
}));
