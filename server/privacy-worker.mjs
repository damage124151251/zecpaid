import {access} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Connection,PublicKey} from '@solana/web3.js';
import {getAssociatedTokenAddressSync} from '@solana/spl-token';
import bs58 from 'bs58';
import {openDatabase} from './db.mjs';
import {AppError,hash,seal,unseal} from './security.mjs';
import {walletPair,requireMoney,operation,tokenAmount,mainnet,publicOperation} from './money.mjs';
import {claimLease,commitWithdrawal,reconcileClaim} from './privacy.mjs';
import {validateDeposit} from './private-proofs.mjs';
import {rpc} from './chain.mjs';
import rail from '../shared/privacy.json' with {type:'json'};
import project from '../shared/project.json' with {type:'json'};
const nativeFetch=globalThis.fetch.bind(globalThis);
const workerData=await new Promise(resolve=>{process.once('message',resolve);process.send({type:'ready'});});
let db,pair,lease,cacheOwner,storageValues=new Map(),activeId,outcome;
const storage={getItem:key=>storageValues.get(key)??null,setItem:(key,value)=>storageValues.set(key,String(value)),removeItem:key=>storageValues.delete(key)};
async function flushCache(){if(!db||!cacheOwner)return;const body=JSON.stringify([...storageValues]);if(body.length>1000000)return;await db.run('INSERT INTO privacy_cache(owner,encrypted,updated) VALUES($1,$2,$3) ON CONFLICT(owner) DO UPDATE SET encrypted=excluded.encrypted,updated=excluded.updated',cacheOwner,seal(Buffer.from(body),`cache:${cacheOwner}`),Date.now());}
function requestUrl(input){return new URL(typeof input==='string'||input instanceof URL?input:input.url);}
globalThis.fetch=async(input,init={})=>{
  const url=requestUrl(input),method=(init.method||'GET').toUpperCase();
  if(url.origin===new URL(rail.relayer).origin&&method==='POST'&&['/deposit/spl','/withdraw/spl'].includes(url.pathname)){
    if(!activeId||workerData.action!=='execute')throw new AppError('No approved private operation is active.',409);
    requireMoney(workerData.owner);
    const row=await operation(db,workerData.owner,activeId),review=JSON.parse(row.review);
    if(row.lease!==lease)throw new AppError('Private worker lease changed.',409);
    const body=JSON.parse(init.body);
    if(url.pathname==='/deposit/spl'){
      const signed=row.signed&&unseal(row.signed,`deposit:${activeId}`).toString();
      if(row.status!=='deposit_signed'||!signed||body.signedTransaction!==signed||body.senderAddress!==review.wallet||body.mintAddress!==project.zecMint||Object.keys(body).some(k=>!['signedTransaction','senderAddress','mintAddress'].includes(k)))throw new AppError('Private deposit relay request differs from the stored approval.',409);
      await db.run("UPDATE money_operations SET status='deposit_pending',updated=$1 WHERE id=$2",Date.now(),activeId);
    }else await commitWithdrawal(db,workerData.owner,activeId,body);
    await flushCache();
    const response=await nativeFetch(input,{...init,signal:AbortSignal.timeout(40000)});
    let result;try{result=await response.clone().json();}catch{}
    if(result?.signature){let valid=false;try{valid=bs58.decode(result.signature).length===64;}catch{}if(valid){if(url.pathname==='/deposit/spl'&&result.signature!==row.signature)throw new AppError('Deposit relayer returned a different transaction signature.',409);if(url.pathname==='/withdraw/spl')await db.run('UPDATE money_operations SET withdrawal_signature=$1,updated=$2 WHERE id=$3',result.signature,Date.now(),activeId);}}
    return response;
  }
  if(method==='POST'&&url.href===new URL(process.env.SOLANA_RPC_URL||'https://api.mainnet-beta.solana.com').href){let body;try{body=JSON.parse(init.body);}catch{}if((Array.isArray(body)?body:[body]).some(b=>b?.method==='sendTransaction'))throw new AppError('Unreviewed direct transaction broadcast is not allowed in the private worker.',409);}
  return nativeFetch(input,{...init,signal:init.signal||AbortSignal.timeout(25000)});
};

async function runtime(){
  for(const k of ['NEXT_PUBLIC_PROGRAM_ID','NEXT_PUBLIC_ALT_ADDRESS','NEXT_PUBLIC_RELAYER_API_URL','NEXT_PUBLIC_ZEC_MINT'])if(process.env[k])throw new AppError('Privacy program, relayer, lookup table and mint overrides are not supported.',503);
  const sdk=await import('privacycash/utils');sdk.setLogger(()=>{});
  const token=sdk.tokens.find(t=>t.pubkey.toBase58()===project.zecMint);
  if(!token||token.units_per_token!==100000000)throw new AppError('The installed provider SDK does not support the pinned ZEC mint.',503);
  const keyBasePath=resolve(dirname(fileURLToPath(import.meta.resolve('privacycash/utils'))),'../circuit2/transaction2');
  await access(`${keyBasePath}.wasm`);await access(`${keyBasePath}.zkey`);
  const {WasmFactory}=await import('@lightprotocol/hasher.rs');const lightWasm=await WasmFactory.getInstance();
  const config={withdraw_fee_rate:await sdk.getConfig('withdraw_fee_rate'),rent_fees:await sdk.getConfig('rent_fees'),minimum_withdrawal:await sdk.getConfig('minimum_withdrawal')};
  return {sdk,keyBasePath,lightWasm,config};
}
async function context(owner,sdk){
  db=await openDatabase();pair=await walletPair(db,owner);cacheOwner=owner;
  const saved=await db.get('SELECT encrypted FROM privacy_cache WHERE owner=$1',owner);
  if(saved){try{storageValues=new Map(JSON.parse(unseal(saved.encrypted,`cache:${owner}`).toString()));}catch{throw new AppError('The encrypted privacy cache could not be restored.',409);}}
  const connection=new Connection(process.env.SOLANA_RPC_URL||'https://api.mainnet-beta.solana.com',{commitment:'finalized',disableRetryOnRateLimit:true});
  await mainnet();
  const encryptionService=new sdk.EncryptionService();encryptionService.deriveEncryptionKeyFromWallet(pair);
  return {connection,encryptionService,publicKey:pair.publicKey,mintAddress:new PublicKey(project.zecMint),storage};
}
async function signDeposit(tx,connection){
  const row=await operation(db,workerData.owner,activeId),review=JSON.parse(row.review);
  if(row.status!=='approved'||row.lease!==lease||Number(row.expires)<Date.now())throw new AppError('Private deposit approval expired or changed.',409);
  const valid=await validateDeposit(tx,review,connection),ata=getAssociatedTokenAddressSync(new PublicKey(project.zecMint),pair.publicKey).toBase58();
  const before=await rpc('getMultipleAccounts',[[review.wallet,ata],{encoding:'base64',commitment:'finalized'}]);
  const unsigned=Buffer.from(tx.serialize()).toString('base64');
  const sim=await rpc('simulateTransaction',[unsigned,{encoding:'base64',commitment:'finalized',sigVerify:false,accounts:{encoding:'base64',addresses:[review.wallet,ata]}}]);
  const oldSol=before.value?.[0]?.lamports,newSol=sim.value.accounts?.[0]?.lamports,cost=oldSol-newSol;
  if(sim.value.err||!Number.isSafeInteger(cost)||cost<0||cost>Number(review.maxDepositSolCostLamports))throw new AppError('The private deposit simulation failed or exceeds the approved SOL budget.',409);
  if(tokenAmount(before.value[1],project.zecMint,review.wallet)-tokenAmount(sim.value.accounts[1],project.zecMint,review.wallet)!==BigInt(review.depositRaw))throw new AppError('The simulated token outflow differs from the approved deposit.',409);
  tx.sign([pair]);const signed=Buffer.from(tx.serialize()).toString('base64'),signature=bs58.encode(tx.signatures[0]);
  await db.tx(async()=>{const fresh=await operation(db,workerData.owner,activeId);if(fresh.status!=='approved'||fresh.lease!==lease)throw new AppError('The private deposit approval changed before signing.',409);await db.run("UPDATE money_operations SET status='deposit_signed',signed=$1,signature=$2,message_hash=$3,result=$4,updated=$5 WHERE id=$6",seal(Buffer.from(signed),`deposit:${activeId}`),signature,valid.messageHash,JSON.stringify({depositProofHash:valid.proofHash,depositBlockhash:tx.message.recentBlockhash}),Date.now(),activeId);});
  return tx;
}
async function execute(runtimeState,ctx){
  requireMoney(workerData.owner);activeId=workerData.id;
  const claimed=await claimLease(db,workerData.owner,activeId);lease=claimed.lease;
  const review=JSON.parse(claimed.row.review);
  if(review.wallet!==pair.publicKey.toBase58())throw new AppError('The private claim wallet changed.',409);
  const args={...ctx,keyBasePath:runtimeState.keyBasePath,lightWasm:runtimeState.lightWasm};
  if(review.depositRaw!=='0'&&!claimed.row.signature){
    await runtimeState.sdk.depositSPL({...args,base_units:Number(review.depositRaw),transactionSigner:tx=>signDeposit(tx,ctx.connection)});
    for(let i=0;i<12;i++){const r=await reconcileClaim(db,workerData.owner,activeId);if(r.status==='deposited')break;if(r.status==='failed')return r;await new Promise(resolve=>setTimeout(resolve,1500));}
    if((await operation(db,workerData.owner,activeId)).status!=='deposited')return publicOperation(await operation(db,workerData.owner,activeId));
  }
  const row=await operation(db,workerData.owner,activeId);
  if(row.proof_hash)return reconcileClaim(db,workerData.owner,activeId);
  await runtimeState.sdk.withdrawSPL({...args,base_units:Number(review.grossRaw),recipient:new PublicKey(review.destination)});
  for(let i=0;i<12;i++){const result=await reconcileClaim(db,workerData.owner,activeId);if(['finalized','failed'].includes(result.status))return result;await new Promise(resolve=>setTimeout(resolve,1500));}
  return publicOperation(await operation(db,workerData.owner,activeId));
}
try{
  if(workerData.action==='execute')requireMoney(workerData.owner);
  const state=await runtime();
  let value;
  if(workerData.action==='health')value={sdk:'privacycash@1.3.1',wasm:true,circuits:true,zecMint:project.zecMint,providerReachable:true,checked:Date.now()};
  else{
    if(!workerData.owner)throw new AppError('A verified account is required.',401);
    const ctx=await context(workerData.owner,state.sdk);
    if(workerData.action==='quote'){
      const notes=await state.sdk.getUtxosSPL(ctx),privateBalance=state.sdk.getBalanceFromUtxosSPL(notes),spendable=notes.map(n=>BigInt(n.amount.toString())).sort((a,b)=>a>b?-1:a<b?1:0).slice(0,2).reduce((a,b)=>a+b,0n);
      if(!Number.isSafeInteger(privateBalance.base_units)||privateBalance.base_units<0)throw new AppError('Unsupported private balance.',409);
      value={config:state.config,privateBalanceRaw:String(privateBalance.base_units),spendableRaw:String(spendable)};
    }else if(workerData.action==='execute')value=await execute(state,ctx);
    else throw new AppError('Unsupported private worker action.');
  }
  await flushCache();outcome={ok:true,value};
}catch(error){
  if(db&&activeId){const row=await operation(db,workerData.owner,activeId).catch(()=>null);if(row){const message=row.signature||row.proof_hash?'The provider response or worker result is uncertain. Reconcile this operation; no new proof will be submitted automatically.':'The private action stopped before any transaction was sent.';await db.run('UPDATE money_operations SET status=$1,error=$2,updated=$3 WHERE id=$4',row.signature||row.proof_hash?row.status:'failed',message,Date.now(),activeId).catch(()=>{});}}
  outcome={ok:false,status:error.status||409,message:error.status?error.message:'The private worker could not complete this step. Check the stored operation before retrying.'};
}finally{
  if(db){await flushCache().catch(()=>{});if(activeId&&lease)await db.run('UPDATE money_operations SET lease=NULL,lease_until=NULL WHERE id=$1 AND lease=$2',activeId,lease).catch(()=>{});await db.close();}
  process.send(outcome);
}
