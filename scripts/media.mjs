import {chromium} from 'playwright';
import {mkdir,readFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const base=process.env.MEDIA_URL||'http://127.0.0.1:5278';
const out=resolve('public/media'),temp=resolve('test-results/media');
await mkdir(out,{recursive:true});await mkdir(temp,{recursive:true});
const data=async(path,mime)=>`data:${mime};base64,${(await readFile(path)).toString('base64')}`;
const mascot=await data('public/brand/zecpaid-mascot-transparent.png','image/png');
const jacquard=await data('public/fonts/jacquard-12.ttf','font/ttf'),pixel=await data('public/fonts/pixelify-sans.ttf','font/ttf');
const browser=await chromium.launch({headless:true});
const style=`@font-face{font-family:J;src:url('${jacquard}')}@font-face{font-family:P;src:url('${pixel}')}*{box-sizing:border-box}body{margin:0;width:1200px;height:675px;background:#101211;color:#fffbe9;font-family:P;letter-spacing:0;overflow:hidden}.frame{position:absolute;inset:16px;border:5px double #ffe09a}.top{position:absolute;top:46px;left:58px;font:38px J;color:#f4b728}.step{position:absolute;right:60px;top:52px;color:#b6b4a6;font:22px P}.copy{position:absolute;left:60px;top:155px;width:540px}h1{font:78px/1.02 J;margin:0 0 27px;letter-spacing:0}p{font:27px/1.4 P;margin:0;max-width:510px;color:#d4d2bd}.mascot{position:absolute;right:21px;bottom:52px;width:565px;height:565px;object-fit:contain;image-rendering:pixelated}.foot{position:absolute;left:60px;bottom:49px;font:21px P;color:#f4b728}.shot{position:absolute;right:53px;top:143px;width:524px;height:423px;object-fit:contain;object-position:center;border:2px solid #5d6244;background:#101211;padding:12px}.with-shot .copy{width:476px}.with-shot h1{font-size:70px}.with-shot p{max-width:450px}.strip{display:flex;gap:14px;margin-top:30px;color:#101211;font-size:24px}.strip span{background:#f4b728;border:5px double #101211;padding:10px 16px}.end .copy{top:188px}.end h1{font-size:99px}.end p{font-size:32px}`;
function graphic({title,text,foot,step='',shot='',end=false}){return `<!doctype html><meta charset="utf-8"><style>${style}</style><body class="${shot?'with-shot':''} ${end?'end':''}"><div class="frame"></div><div class="top">ZecPaid</div><div class="step">${step}</div><div class="copy"><h1>${title}</h1><p>${text}</p></div>${shot?`<img class="shot" src="${shot}" alt="Actual ZecPaid interface">`:`<img class="mascot" src="${mascot}" alt="ZecPaid courier">`}<div class="foot">${foot}</div></body>`;}
try{
  const page=await browser.newPage({viewport:{width:1200,height:675}});
  await page.addInitScript(()=>sessionStorage.setItem('zecpaid-intro-v2','1'));
  await page.goto(`${base}/?capture=1`);await page.evaluate(()=>document.fonts.ready);
  await page.locator('#recipient').fill('@zecpaid');await page.getByRole('button',{name:'Find',exact:true}).click();
  await page.locator('.recipient-result').waitFor({timeout:25000});
  const lookup=await page.locator('.recipient-result').screenshot();
  await page.locator('#token-name').fill('Builder support');await page.locator('#ticker').fill('BUILD');
  await page.locator('#description').fill('A community coin supporting the person behind a useful project.');
  await page.locator('.token-form-body').screenshot({path:resolve(temp,'prepare.png')});
  const prepare=await data(resolve(temp,'prepare.png'),'image/png');
  const scenes=[
    {title:'Pay the person<br>behind the code.',text:'Choose a builder on X.<br>Check who receives the creator fees.',foot:'Start with their @',step:'Find the builder'},
    {title:'Choose an @.<br>Prepare the coin.',text:'Add a name, ticker and image.<br>Review the ZEC pair and fee recipient.',foot:'Protocol and LP fees are separate.',step:'Review the launch',shot:prepare},
    {title:'Your X account.<br>Your fee wallet.',text:'Connect X. Open My ZEC.<br>Review the amount, receiving address and provider fee before a claim.',foot:'ZEC on Solana · Privacy Cash withdrawal route',step:'Review the claim'}
  ];
  for(let i=0;i<scenes.length;i++){await page.setContent(graphic(scenes[i]));await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:resolve(out,`post-0${i+1}.png`)});}
  await page.close();
  const ctx=await browser.newContext({viewport:{width:1200,height:675},recordVideo:{dir:temp,size:{width:1200,height:675}}});
  const film=await ctx.newPage(),video=film.video();
  await film.goto(`${base}/?capture=1`);await film.waitForTimeout(3300);
  await film.locator('#recipient').pressSequentially('@zecpaid',{delay:140});
  await film.getByRole('button',{name:'Find',exact:true}).click();await film.locator('.recipient-result').waitFor({timeout:25000});
  await film.waitForTimeout(1400);
  await film.locator('#token-name').pressSequentially('Builder support',{delay:80});
  await film.locator('#ticker').pressSequentially('BUILD',{delay:100});
  await film.waitForTimeout(1000);
  await film.setContent(graphic({title:'Start with<br>their @.',text:'Choose the person.<br>Review the fee route.',foot:'ZecPaid',end:true}));
  await film.evaluate(()=>document.fonts.ready);await film.waitForTimeout(2800);
  await ctx.close();const source=await video.path();
  execFileSync('ffmpeg',['-y','-i',source,'-an','-c:v','libx264','-preset','medium','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart',resolve(out,'zecpaid-how-to.mp4')],{stdio:'pipe'});
  for(const name of ['zecpaid-avatar.png','zecpaid-banner-x.png','zecpaid-mascot-transparent.png'])await copyFile(resolve('public/brand',name),resolve(out,name));
  console.log('Created three 1200x675 post images, a silent actual-interface walkthrough and the approved brand exports. No launch or payout was simulated.');
}finally{await browser.close();}
