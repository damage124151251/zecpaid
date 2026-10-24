import {createRequire} from 'node:module';
import {Connection,PublicKey} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction,getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import {AppError} from './security.mjs';
import {collectorWallet} from './accounts.mjs';
import {createOperation,mainnet,prepareTransaction} from './money.mjs';
import project from '../shared/project.json' with {type:'json'};
const require=createRequire(import.meta.url);
const {OnlinePumpSdk,PumpSdk,getPumpAmmProgram,canonicalPumpPoolPdaWithQuote,normalizeQuoteMint}=require('@pump-fun/pump-sdk');
export function feeServices(){
  const connection=new Connection(process.env.SOLANA_RPC_URL||'https://api.mainnet-beta.solana.com',{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15000)})});
  return {connection,online:new OnlinePumpSdk(connection),sdk:new PumpSdk(),amm:getPumpAmmProgram(connection)};
}
export async function feeOverview(db,owner,services=feeServices()){
  const address=await collectorWallet(db,owner);
  const projects=await db.all("SELECT DISTINCT p.id,p.name,p.symbol,l.mint FROM projects p JOIN plans l ON l.project_id=p.id WHERE p.recipient=$1 AND l.status='finalized' ORDER BY p.id LIMIT 50",owner);
  const balances=await services.online.getCreatorVaultQuoteBalances(new PublicKey(address),[new PublicKey(project.zecMint)]);
  const zec=balances.find(b=>b.mint.toBase58()===project.zecMint);
  return {address,projects,vaultRaw:zec?.total.toString()||'0',checked:Date.now(),scope:'Creator vaults only. Curve and pool accruals are checked per selected coin.'};
}
export async function prepareFeeCollection(db,owner,projectId,services=feeServices(),read){
  await mainnet(read);
  const row=await db.get("SELECT p.id,p.name,l.mint FROM projects p JOIN plans l ON l.project_id=p.id WHERE p.id=$1 AND p.recipient=$2 AND l.status='finalized'",projectId,owner);
  if(!row)throw new AppError('A finalized ZecPaid coin for your X account is required.',404);
  const pending=await db.get("SELECT id FROM money_operations WHERE owner=$1 AND kind='fees' AND status='pending'",owner);
  if(pending)throw new AppError('Reconcile the pending fee transaction first.',409);
  const wallet=await collectorWallet(db,owner),creator=new PublicKey(wallet),mint=new PublicKey(row.mint),quoteMint=new PublicKey(project.zecMint);
  const curve=await services.online.fetchBondingCurve(mint);
  if(!curve.creator.equals(creator)||!normalizeQuoteMint(curve.quoteMint).equals(quoteMint))throw new AppError('The coin no longer has the expected creator or ZEC pair.',409);
  const resolved=await services.online.resolveQuoteMint(quoteMint);
  if(!resolved.quoteTokenProgram.equals(TOKEN_PROGRAM_ID))throw new AppError('Only the pinned standard SPL ZEC mint is supported.',409);
  const instructions=[await services.sdk.sweepCreatorFeeInstruction({payer:creator,mint,creator,quoteMint,quoteTokenProgram:TOKEN_PROGRAM_ID})];
  if(curve.complete){
    const pool=await services.amm.account.pool.fetchNullable(canonicalPumpPoolPdaWithQuote(mint,quoteMint));
    if(pool){
      if(!pool.baseMint.equals(mint)||!pool.quoteMint.equals(quoteMint)||!pool.coinCreator.equals(creator))throw new AppError('The migrated pool fee recipient differs from your wallet.',409);
      instructions.push(await services.sdk.sweepPoolCreatorFeeInstruction({payer:creator,mint,coinCreator:creator,quoteMint,quoteTokenProgram:TOKEN_PROGRAM_ID}));
      const ata=getAssociatedTokenAddressSync(quoteMint,creator);
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(creator,ata,creator,quoteMint));
      instructions.push(await services.amm.methods.collectCoinCreatorFee().accountsPartial({coinCreator:creator,coinCreatorTokenAccount:ata,quoteMint,quoteTokenProgram:TOKEN_PROGRAM_ID}).instruction());
    }
  }
  // Always include the Pump leg; the sweep may create a previously absent vault ATA.
  const collect=await services.online.collectCoinCreatorFeeV2Instructions(creator,quoteMint,TOKEN_PROGRAM_ID,creator);
  const seen=new Set(instructions.map(ix=>ix.programId.toBase58()+':'+ix.data.toString('hex')+':'+ix.keys.map(k=>k.pubkey.toBase58()).join(',')));
  for(const ix of collect){const key=ix.programId.toBase58()+':'+ix.data.toString('hex')+':'+ix.keys.map(k=>k.pubkey.toBase58()).join(',');if(!seen.has(key)){instructions.push(ix);seen.add(key);}}
  const prepared=await prepareTransaction(wallet,instructions,read);
  return createOperation(db,owner,'fees',projectId,{wallet,coin:row.name,mint:row.mint,quoteMint:project.zecMint,expectedZecRaw:prepared.expectedZecRaw,maxSolCostLamports:prepared.costLamports,recipient:wallet,scope:'Selected curve/pool sweep plus this creator wallet\'s ZEC vaults. Actual received amount is verified after finalization.'},prepared);
}
