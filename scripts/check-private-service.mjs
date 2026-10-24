const base=process.argv[2]||process.env.PUBLIC_URL;
if(!base||!process.env.CRON_SECRET)throw Error('PUBLIC_URL and the project operator token are required.');
const r=await fetch(`${new URL(base).origin}/api/operator/check-privacy`,{method:'POST',headers:{Origin:new URL(base).origin,Authorization:`Bearer ${process.env.CRON_SECRET}`},signal:AbortSignal.timeout(90000)});
const body=await r.json();
if(!r.ok)throw Error(body.error||'Private runtime check failed.');
console.log(JSON.stringify(body,null,2));
