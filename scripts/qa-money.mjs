import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const browser=await chromium.launch({headless:true}),base=process.env.QA_URL||'http://127.0.0.1:5278';
await mkdir('test-results',{recursive:true});
// These are isolated UI fixtures, never live accounts, receipts or marketing media.
const wallet='11111111111111111111111111111111';
const quote={id:'ui-fixture',kind:'private_claim',status:'quoted',review:{wallet,destination:wallet,netRaw:'1000000',grossRaw:'1054500',providerFeeRaw:'54500',depositRaw:'1054500',maxDepositSolCostLamports:'5000000',needsFunding:false},created:Date.now(),expires:Date.now()+180000};
try{
  for(const [width,height] of [[1440,900],[390,844],[320,640]]){
    const page=await browser.newPage({viewport:{width,height}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>sessionStorage.setItem('zecpaid-intro-v2','1'));
    await page.route('**/api/**',async route=>{
      const p=new URL(route.request().url()).pathname;
      const fixtures={'/api/me':{id:'fixture-only',username:'ui_fixture',wallet},'/api/balances/me':{zecRaw:'2000000',solLamports:'5000000'},'/api/fees':{vaultRaw:'0',projects:[]},'/api/operations':[], '/api/claims/prepare':quote};
      if(p==='/api/status'){const r=await route.fetch(),s=await r.json();return route.fulfill({json:{...s,feeCollectionReady:false,privatePayoutReady:false}});}
      if(Object.hasOwn(fixtures,p))return route.fulfill({json:fixtures[p]});
      if(route.request().method()==='POST')throw Error('Unexpected financial request in UI fixture test.');
      return route.continue();
    });
    await page.goto(base);await page.evaluate(()=>document.fonts.ready);
    await page.getByTitle('My ZEC',{exact:true}).click();
    await page.locator('#destination').fill(wallet);
    await page.getByRole('button',{name:'Review private claim',exact:true}).click();
    const modal=page.getByRole('dialog');await modal.waitFor();
    assert.match(await modal.innerText(),/0\.01 ZEC/);assert.match(await modal.innerText(),/0\.000545 ZEC/);
    assert.ok(await modal.getByRole('button',{name:'Approve private claim',exact:true}).isDisabled());
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),height);
    const overflow=await modal.locator('button').evaluateAll(ns=>ns.filter(n=>n.scrollWidth>n.clientWidth+3).map(n=>n.innerText));assert.deepEqual(overflow,[]);
    await page.screenshot({path:resolve('test-results',`fixture-money-${width}.png`)});
    await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log('Money UI fixture checks passed at 1440, 390 and 320 pixels. No financial request was approved.');
}finally{await browser.close();}
