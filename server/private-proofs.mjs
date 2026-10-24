import {PublicKey,TransactionMessage,ComputeBudgetProgram,SystemProgram} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {createHash} from 'node:crypto';
import * as borsh from 'borsh';
import bs58 from 'bs58';
import {AppError,hash} from './security.mjs';
import rail from '../shared/privacy.json' with {type:'json'};
import project from '../shared/project.json' with {type:'json'};
const program=new PublicKey(rail.program),mint=new PublicKey(project.zecMint),feeRecipient=new PublicKey(rail.feeRecipient);
const FIELD=21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const array=len=>({array:{type:'u8',len}}),vector={array:{type:'u8'}};
export const proofSchema={struct:{a:array(64),b:array(128),c:array(64),root:array(32),publicAmount:array(32),extHash:array(32),null0:array(32),null1:array(32),commit0:array(32),commit1:array(32),extAmount:'i64',fee:'u64',encrypted0:vector,encrypted1:vector}};
const extSchema={struct:{recipient:array(32),extAmount:'i64',encrypted0:vector,encrypted1:vector,fee:'u64',feeRecipient:array(32),mint:array(32)}};
export const discriminator=Buffer.from([154,66,244,204,78,225,163,151]);
const big=b=>BigInt(`0x${Buffer.from(b).toString('hex')}`);
const pda=(...seeds)=>PublicKey.findProgramAddressSync(seeds.map(s=>Buffer.isBuffer(s)?s:Buffer.from(s)),program)[0].toBase58();
export function decodeProof(bytes){
  if(bytes.length>6000||!bytes.subarray(0,8).equals(discriminator))throw new AppError('Unsupported privacy instruction.',409);
  let proof;try{proof=borsh.deserialize(proofSchema,bytes.subarray(8));if(!Buffer.from(borsh.serialize(proofSchema,proof)).equals(bytes.subarray(8)))throw Error();}catch{throw new AppError('Malformed privacy proof.',409);}
  if([proof.encrypted0,proof.encrypted1].some(a=>a.length<16||a.length>1024))throw new AppError('Unsupported encrypted output size.',409);
  return proof;
}
export function proofAccounts(proof,recipient){
  const ata=getAssociatedTokenAddressSync(mint,new PublicKey(recipient),true).toBase58(),feeAta=getAssociatedTokenAddressSync(mint,feeRecipient,true).toBase58(),global=pda('global_config');
  return {recipient,recipientAta:ata,mintAddress:project.zecMint,feeRecipientAccount:rail.feeRecipient,feeRecipientTokenAccount:feeAta,lookupTableAddress:rail.lookupTable,globalConfigAccount:global,treeTokenAccount:pda('tree_token'),treeAccount:pda('merkle_tree',mint.toBuffer()),treeAta:getAssociatedTokenAddressSync(mint,new PublicKey(global),true).toBase58(),nullifier0PDA:pda('nullifier0',Buffer.from(proof.null0)),nullifier1PDA:pda('nullifier1',Buffer.from(proof.null1)),nullifier2PDA:pda('nullifier0',Buffer.from(proof.null1)),nullifier3PDA:pda('nullifier1',Buffer.from(proof.null0))};
}
export function validateProofBinding(proof,recipientAta,amount,fee){
  if(proof.extAmount!==amount||proof.fee!==fee)throw new AppError('Privacy proof amount or fee differs from the approved quote.',409);
  const feeAta=getAssociatedTokenAddressSync(mint,feeRecipient,true);
  const ext=borsh.serialize(extSchema,{recipient:[...new PublicKey(recipientAta).toBytes()],extAmount:amount,encrypted0:proof.encrypted0,encrypted1:proof.encrypted1,fee,feeRecipient:[...feeAta.toBytes()],mint:[...mint.toBytes()]});
  const digest=createHash('sha256').update(ext).digest();
  if(big(Buffer.from(digest).reverse())%FIELD!==big(proof.extHash)%FIELD||big(proof.publicAmount)%FIELD!==((amount-fee)%FIELD+FIELD)%FIELD)throw new AppError('The privacy proof does not bind the approved recipient and amount.',409);
}
export function validateWithdrawal(review,body){
  if(!body||typeof body.serializedProof!=='string'||body.serializedProof.length>8000||body.referralId)throw new AppError('Invalid private withdrawal request.',409);
  const bytes=Buffer.from(body.serializedProof,'base64');if(bytes.toString('base64')!==body.serializedProof)throw new AppError('Invalid proof encoding.',409);
  const proof=decodeProof(bytes),accounts=proofAccounts(proof,review.destination),net=BigInt(review.netRaw),fee=BigInt(review.providerFeeRaw);
  if(!Number.isSafeInteger(body.extAmount)||BigInt(body.extAmount)!==-net||!Number.isSafeInteger(body.fee)||BigInt(body.fee)!==fee||net+fee!==BigInt(review.grossRaw))throw new AppError('Partial or changed withdrawals are not allowed.',409);
  for(const [key,value] of Object.entries(accounts))if(body[key]!==value)throw new AppError(`Pinned privacy account mismatch: ${key}.`,409);
  validateProofBinding(proof,accounts.recipientAta,-net,fee);
  return {proofHash:hash(bytes),body:{serializedProof:body.serializedProof,...accounts,extAmount:body.extAmount,fee:body.fee}};
}
export async function validateDeposit(tx,review,connection){
  if(tx.message.header.numRequiredSignatures!==1||tx.message.staticAccountKeys[0].toBase58()!==review.wallet||tx.message.addressTableLookups.length!==1||tx.message.addressTableLookups[0].accountKey.toBase58()!==rail.lookupTable)throw new AppError('Unsupported private deposit transaction.',409);
  const table=await connection.getAddressLookupTable(new PublicKey(rail.lookupTable));if(!table.value)throw new AppError('Pinned privacy lookup table is unavailable.',503);
  const message=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:[table.value]});
  const privacy=message.instructions.filter(i=>i.programId.equals(program));
  if(privacy.length!==1||message.instructions.length>3||message.instructions.some(i=>!i.programId.equals(program)&&!i.programId.equals(ComputeBudgetProgram.programId)))throw new AppError('Unexpected deposit instruction.',409);
  for(const ix of message.instructions.filter(i=>i.programId.equals(ComputeBudgetProgram.programId))){const opcode=ix.data[0];if(opcode===2){if(ix.data.length!==5||ix.data.readUInt32LE(1)>400000)throw new AppError('Deposit compute limit changed.',409);}else if(opcode===3){if(ix.data.length!==9||ix.data.readBigUInt64LE(1)>400000n)throw new AppError('Deposit priority fee changed.',409);}else throw new AppError('Unsupported compute instruction.',409);}
  const ix=privacy[0],proof=decodeProof(ix.data),a=proofAccounts(proof,rail.feeRecipient),senderAta=getAssociatedTokenAddressSync(mint,new PublicKey(review.wallet)).toBase58();
  const expected=[a.treeAccount,a.nullifier0PDA,a.nullifier1PDA,a.nullifier2PDA,a.nullifier3PDA,a.globalConfigAccount,review.wallet,project.zecMint,senderAta,rail.feeRecipient,a.recipientAta,a.treeAta,a.feeRecipientTokenAccount,TOKEN_PROGRAM_ID.toBase58(),ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),SystemProgram.programId.toBase58()];
  if(ix.keys.length!==expected.length||ix.keys.some((k,i)=>k.pubkey.toBase58()!==expected[i]))throw new AppError('Private deposit account list changed.',409);
  validateProofBinding(proof,a.recipientAta,BigInt(review.depositRaw),0n);
  return {proofHash:hash(ix.data),messageHash:hash(tx.message.serialize()),senderAta};
}
export function withdrawalReceipt(review,proofHash,body,receipt){
  if(!receipt?.meta||receipt.meta.err||!Number.isSafeInteger(receipt.slot)||receipt.slot<=0||!receipt.transaction?.signatures?.[0])throw new AppError('A successful finalized withdrawal receipt is required.',409);
  const message=receipt.transaction.message,ix=message.instructions?.filter(i=>String(i.programId)===rail.program);
  if(ix?.length!==1||typeof ix[0].data!=='string'||hash(bs58.decode(ix[0].data))!==proofHash)throw new AppError('Withdrawal receipt does not match the committed proof.',409);
  for(const address of [body.recipientAta,body.mintAddress,body.feeRecipientTokenAccount,body.treeAccount,body.nullifier0PDA,body.nullifier1PDA])if(!ix[0].accounts?.includes(address))throw new AppError('Withdrawal receipt account mismatch.',409);
  const keys=message.accountKeys.map(k=>String(k.pubkey||k)),index=keys.indexOf(body.recipientAta),pre=receipt.meta.preTokenBalances?.find(b=>b.accountIndex===index),post=receipt.meta.postTokenBalances?.find(b=>b.accountIndex===index);
  const valid=b=>b.mint===project.zecMint&&b.owner===review.destination&&b.uiTokenAmount?.decimals===8&&/^\d+$/.test(b.uiTokenAmount.amount);
  if(index<0||!post||!valid(post)||pre&&!valid(pre)||BigInt(post.uiTokenAmount.amount)-BigInt(pre?.uiTokenAmount.amount||'0')!==BigInt(review.netRaw))throw new AppError('The exact recipient ZEC receipt could not be verified.',409);
  return {signature:receipt.transaction.signatures[0],slot:receipt.slot,netRaw:review.netRaw,providerFeeRaw:review.providerFeeRaw,verifiedAt:Date.now()};
}
