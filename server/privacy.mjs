import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PublicKey,SystemProgram} from '@solana/web3.js';
import {randomUUID} from 'node:crypto';
import {AppError,seal,unseal,hash} from './security.mjs';
import {collectorWallet} from './accounts.mjs';
import {balances,rpc} from './chain.mjs';
import {createOperation,operation,publicOperation,requireMoney,mainnet,signedTransaction} from './money.mjs';
import {validateWithdrawal,withdrawalReceipt} from './private-proofs.mjs';
import rail from '../shared/privacy.json' with {type:'json'};
import project from '../shared/project.json' with {type:'json'};

export function parseZec(value){
  if(typeof value!=='string'||!/^\d{1,4}(\.\d{1,8})?$/.test(value))throw new AppError('Enter a ZEC amount with at most eight decimal places.');
  const [a,b='']=value.split('.'),raw=BigInt(a)*100000000n+BigInt(b.padEnd(8,'0'));
  if(raw<=0n||raw>BigInt(rail.maxClaimGrossRaw))throw new AppError('This release limits a claim to at most 1 ZEC before provider fees.');
  return raw;
}
export function privateQuote(netRaw,config){
  const net=Number(netRaw),rate=config.withdraw_fee_rate,rent=config.rent_fees?.zec,minimum=config.minimum_withdrawal?.zec;
  if(!Number.isSafeInteger(net)||net<=0||!Number.isFinite(rate)||rate<0||rate>=.02||!Number.isFinite(rent)||rent<=0||rent>.01||!Number.isFinite(minimum)||minimum<=0||minimum>1)throw new AppError('Privacy Cash fee configuration is outside the reviewed limits.',503);
  if(net<Math.ceil(minimum*100000000))throw new AppError(`The provider currently requires at least ${minimum} ZEC received.`,409);
  const received=gross=>gross-Math.floor(gross*rate+100000000*rent);
  let low=net,high=net+Math.ceil(net*.1+rent*100000000+1000);
  while(low<high){const mid=Math.floor((low+high)/2);if(received(mid)<net)low=mid+1;else high=mid;}
  if(received(low)!==net||BigInt(low)>BigInt(rail.maxClaimGrossRaw))throw new AppError('This amount exceeds the reviewed per-claim limit after fees.',409);
  return {netRaw:String(net),grossRaw:String(low),providerFeeRaw:String(low-net),feeRate:rate,rentFee:rent,minimumNetRaw:String(Math.ceil(minimum*100000000))};
}
export async function runPrivacyWorker(action,input={}){
  await import('privacycash/utils');
  await import('@lightprotocol/hasher.rs');
  return new Promise((resolve,reject)=>{
    const worker=fork(fileURLToPath(new URL('./privacy-worker.mjs',import.meta.url)),[],{execArgv:['--max-old-space-size=1536'],stdio:['ignore','ignore','ignore','ipc']});
    let settled=false;
    const timer=setTimeout(()=>{settled=true;worker.kill();reject(new AppError('The proof worker timed out. Reconcile this operation before another attempt.',409));},240000);
    worker.on('message',result=>{if(result?.type==='ready'){worker.send({action,...input});return;}settled=true;clearTimeout(timer);worker.kill();if(result.ok)resolve(result.value);else reject(new AppError(result.message||'Private operation requires reconciliation.',result.status||409));});
    worker.once('error',()=>{if(!settled){settled=true;clearTimeout(timer);worker.kill();reject(new AppError('Private worker interrupted. Check the stored operation before retrying.',503));}});
    worker.once('exit',code=>{if(!settled){settled=true;clearTimeout(timer);reject(new AppError(`Private worker exited before completion (${code}). Check the operation receipt.`,503));}});
  });
}
export async function prepareClaim(db,owner,input,run=runPrivacyWorker,read=rpc){
  const netRaw=parseZec(input.amount);let destination;try{destination=new PublicKey(input.destination).toBase58();}catch{throw new AppError('Enter a valid Solana receiving wallet.');}
  if(!PublicKey.isOnCurve(new PublicKey(destination)))throw new AppError('Use an ordinary on-curve Solana receiving wallet.');
  const wallet=await collectorWallet(db,owner);
  if(destination===wallet)throw new AppError('Use a different receiving wallet for a private withdrawal.');
  await mainnet(read);
  const account=await read('getAccountInfo',[destination,{encoding:'base64',commitment:'finalized'}]);
  if(account.value&&account.value.owner!==SystemProgram.programId.toBase58())throw new AppError('The recipient must be a Solana wallet, not a mint, token account or program.');
  const pending=await db.get("SELECT id FROM money_operations WHERE owner=$1 AND kind='private_claim' AND status NOT IN ('quoted','finalized','failed','expired','cancelled')",owner);
  if(pending)throw new AppError('A private claim is pending. Reconcile or safely cancel it before preparing another.',409);
  const state=await run('quote',{owner}),quote=privateQuote(netRaw,state.config),publicBalance=await balances(wallet,read);
  const deposit=BigInt(state.spendableRaw)<BigInt(quote.grossRaw)?quote.grossRaw:'0';
  const needsZec=BigInt(publicBalance.zecRaw)<BigInt(deposit),needsSol=deposit!=='0'&&BigInt(publicBalance.solLamports)<BigInt(rail.maxDepositSolCostLamports);
  return createOperation(db,owner,'private_claim',destination,{...quote,wallet,destination,zecMint:project.zecMint,privateBalanceRaw:state.privateBalanceRaw,depositRaw:deposit,maxDepositSolCostLamports:deposit==='0'?'0':rail.maxDepositSolCostLamports,needsFunding:needsZec||needsSol,publicZecRaw:publicBalance.zecRaw,publicSolLamports:publicBalance.solLamports,publicDeposit:deposit!=='0',completeAnonymity:false});
}
export async function approveClaim(db,owner,id,run=runPrivacyWorker){
  requireMoney(owner);
  const row=await db.tx(async()=>{
    const value=await operation(db,owner,id);
    if(value.kind!=='private_claim')throw new AppError('Wrong operation type.',409);
    if(value.status!=='quoted')throw new AppError('This claim was already approved. Check its receipt.',409);
    if(Number(value.expires)<Date.now())throw new AppError('The claim quote expired. Review a fresh quote.',409);
    if(JSON.parse(value.review).needsFunding)throw new AppError('The reviewed funding balance is insufficient. No deposit or withdrawal was submitted.',409);
    const active=await db.get("SELECT id FROM money_operations WHERE owner=$1 AND id<>$2 AND status NOT IN ('quoted','finalized','failed','expired','cancelled')",owner,id);
    if(active)throw new AppError('Another claim for this account needs reconciliation.',409);
    await db.run("UPDATE money_operations SET status='approved',updated=$1 WHERE id=$2",Date.now(),id);return value;
  });
  await run('execute',{owner,id:row.id});
  return publicOperation(await operation(db,owner,id));
}
export async function commitWithdrawal(db,owner,id,body){
  requireMoney(owner);
  return db.tx(async()=>{
    const row=await operation(db,owner,id),review=JSON.parse(row.review);
    if(row.kind!=='private_claim'||!['approved','deposited'].includes(row.status))throw new AppError('This operation cannot submit a new withdrawal proof.',409);
    if(row.proof_hash)throw new AppError('A withdrawal proof is already committed. Reconcile it instead of paying again.',409);
    if(!row.signature&&Number(row.expires)<Date.now())throw new AppError('Private withdrawal approval expired.',409);
    const valid=validateWithdrawal(review,body);
    await db.run("UPDATE money_operations SET status='withdraw_pending',proof_hash=$1,proof_data=$2,updated=$3 WHERE id=$4",valid.proofHash,seal(Buffer.from(JSON.stringify(valid.body)),`proof:${id}`),Date.now(),id);
    return valid;
  });
}
export async function reconcileClaim(db,owner,id,read=rpc){
  let row=await operation(db,owner,id);
  if(row.kind!=='private_claim'||['quoted','finalized','failed','expired','cancelled'].includes(row.status))return publicOperation(row);
  const review=JSON.parse(row.review);
  if(row.signature&&!row.proof_hash&&row.status!=='deposited'){
    const tx=await read('getTransaction',[row.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
    if(tx){
      const encoded=unseal(row.signed,`deposit:${id}`).toString(),signed=signedTransaction(encoded,row.message_hash,review.wallet);
      const receipt=signedTransaction(tx.transaction[0],row.message_hash,review.wallet);
      if(hash(signed.serialize())!==hash(receipt.serialize())||!tx.meta)throw new AppError('Private deposit receipt differs from the signed transaction.',409);
      if(tx.meta.err){await db.run("UPDATE money_operations SET status='failed',error=$1,updated=$2 WHERE id=$3",'The deposit transaction failed on-chain. No withdrawal was sent.',Date.now(),id);return publicOperation(await operation(db,owner,id));}
      const ata=(await import('@solana/spl-token')).getAssociatedTokenAddressSync(new PublicKey(project.zecMint),new PublicKey(review.wallet)).toBase58();
      const keys=[...receipt.message.staticAccountKeys.map(k=>k.toBase58()),...(tx.meta.loadedAddresses?.writable||[]),...(tx.meta.loadedAddresses?.readonly||[])],index=keys.indexOf(ata);
      const matching=b=>b.accountIndex===index&&b.owner===review.wallet&&b.mint===project.zecMint&&b.uiTokenAmount?.decimals===8;
      const before=tx.meta.preTokenBalances?.find(matching),after=tx.meta.postTokenBalances?.find(matching);
      if(index<0||!before||!after||BigInt(before.uiTokenAmount.amount)-BigInt(after.uiTokenAmount.amount)!==BigInt(review.depositRaw))throw new AppError('The exact approved private deposit could not be verified.',409);
      await db.run("UPDATE money_operations SET status='deposited',result=$1,error=NULL,updated=$2 WHERE id=$3",JSON.stringify({depositSignature:row.signature,depositSlot:tx.slot}),Date.now(),id);
    }else if(row.status==='deposit_signed'||row.status==='deposit_pending'){
      const result=row.result?JSON.parse(row.result):{};
      if(result.depositBlockhash){
        const valid=await read('isBlockhashValid',[result.depositBlockhash,{commitment:'finalized'}]);
        if(valid.value===false){const known=await read('getSignatureStatuses',[[row.signature],{searchTransactionHistory:true}]);if(known.value?.[0]===null)await db.run("UPDATE money_operations SET status='expired',error=$1,updated=$2 WHERE id=$3",'The signed deposit expired without an on-chain receipt. No withdrawal was submitted.',Date.now(),id);}
      }
    }
  }
  row=await operation(db,owner,id);
  if(!row.proof_hash)return publicOperation(row);
  const body=JSON.parse(unseal(row.proof_data,`proof:${id}`).toString());
  let candidates=row.withdrawal_signature?[{signature:row.withdrawal_signature}]:await read('getSignaturesForAddress',[body.nullifier0PDA,{limit:5,commitment:'finalized'}]);
  if(!Array.isArray(candidates))throw new AppError('Withdrawal history is unavailable. No new proof will be sent.',503);
  for(const candidate of candidates){
    const receipt=await read('getTransaction',[candidate.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);
    if(!receipt)continue;
    if(row.withdrawal_signature&&receipt.meta?.err){await db.run("UPDATE money_operations SET status='failed',error=$1,updated=$2 WHERE id=$3",'The withdrawal failed on-chain; private funds must be reconciled before a new quote.',Date.now(),id);break;}
    let verified;try{verified=withdrawalReceipt(review,row.proof_hash,body,receipt);}catch{continue;}
    if(verified.signature!==candidate.signature)continue;
    await db.run("UPDATE money_operations SET status='finalized',withdrawal_signature=$1,result=$2,error=NULL,updated=$3 WHERE id=$4",candidate.signature,JSON.stringify(verified),Date.now(),id);break;
  }
  return publicOperation(await operation(db,owner,id));
}
export async function resumeClaim(db,owner,id,run=runPrivacyWorker){
  requireMoney(owner);const row=await operation(db,owner,id);
  if(row.kind!=='private_claim'||row.status!=='deposited'||row.proof_hash)throw new AppError('Only a verified deposited claim without a withdrawal proof can resume.',409);
  await run('execute',{owner,id});return publicOperation(await operation(db,owner,id));
}
export async function cancelClaim(db,owner,id){
  return db.tx(async()=>{const row=await operation(db,owner,id);if(row.kind!=='private_claim'||!['quoted','approved','deposited'].includes(row.status)||row.proof_hash||row.lease&&Number(row.lease_until)>Date.now())throw new AppError('This operation cannot be cancelled while a transaction or proof may be in flight.',409);await db.run("UPDATE money_operations SET status='cancelled',updated=$1 WHERE id=$2",Date.now(),id);return publicOperation(await operation(db,owner,id));});
}
export async function claimLease(db,owner,id){
  return db.tx(async()=>{const row=await operation(db,owner,id);if(!['approved','deposited'].includes(row.status)||row.lease&&Number(row.lease_until)>Date.now())throw new AppError('This claim is already running or pending. Reconcile its receipt.',409);const lease=randomUUID();await db.run('UPDATE money_operations SET lease=$1,lease_until=$2,updated=$3 WHERE id=$4',lease,Date.now()+270000,Date.now(),id);return {row,lease};});
}
