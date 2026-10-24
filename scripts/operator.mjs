import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
const envFile = resolve('.env.local');
const backup = resolve(homedir(), '.codex/private/zecpaid/vault-master.json');
const ownKeys = ['DATABASE_URL','PUBLIC_URL','CUSTODY_ENCRYPTION_KEY','X_CLIENT_ID','X_CLIENT_SECRET','X_BEARER_TOKEN','SOLANA_RPC_URL','ENABLE_LAUNCH'];
async function readEnv() { try { return parseEnv(await readFile(envFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
async function store(env) {
  const lines = ownKeys.filter(k => env[k] !== undefined).map(k => `${k}=${JSON.stringify(env[k])}`);
  await writeFile(envFile, '# ZecPaid operator configuration. Never commit or share.\n' + lines.join('\n') + '\n', { mode: 0o600 });
}
async function initialize() {
  const env = await readEnv();
  let saved;
  try { saved = JSON.parse(await readFile(backup, 'utf8')).key; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (saved && env.CUSTODY_ENCRYPTION_KEY && saved !== env.CUSTODY_ENCRYPTION_KEY) throw Error('Vault key mismatch. Stop and inspect the existing operator backup.');
  env.CUSTODY_ENCRYPTION_KEY ||= saved || randomBytes(32).toString('base64');
  if (!saved) {
    await mkdir(resolve(backup, '..'), { recursive: true });
    await writeFile(backup, JSON.stringify({ project: 'zecpaid', key: env.CUSTODY_ENCRYPTION_KEY, created: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    if (process.platform === 'win32') {
      await new Promise((resolvePromise, reject) => { const p = spawn('icacls.exe', [backup, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`], { stdio: 'ignore' }); p.once('exit', code => code === 0 ? resolvePromise() : reject(Error('Could not restrict vault backup permissions.'))); p.once('error', reject); });
    }
  }
  env.PUBLIC_URL ||= 'http://127.0.0.1:5278';
  env.SOLANA_RPC_URL ||= 'https://api.mainnet-beta.solana.com';
  env.ENABLE_LAUNCH ||= 'false';
  for (const k of ['X_CLIENT_ID','X_CLIENT_SECRET','X_BEARER_TOKEN']) env[k] ||= '';
  await store(env);
  console.log('ZecPaid vault initialized. Key backed up locally with restricted file access. No key was printed.');
}
async function push(names) {
  const env = await readEnv();
  for (const name of names) {
    if (!ownKeys.includes(name) || name === 'DATABASE_URL' || !env[name]) throw Error(`Missing or disallowed variable: ${name}`);
    const args = ['--yes','vercel@64.7.0','env','add',name,'--environment','production','--force','--yes','--scope','torufins-projects','--project','zecpaid','--non-interactive',name === 'PUBLIC_URL' ? '--no-sensitive' : '--sensitive'];
    await new Promise((resolvePromise, reject) => {
      const p = process.platform === 'win32' ? spawn(process.env.ComSpec || 'cmd.exe', ['/d','/s','/c', ['npx', ...args].join(' ')], { stdio: ['pipe','pipe','pipe'] }) : spawn('npx', args, { stdio: ['pipe','pipe','pipe'] });
      let output = ''; p.stdout.on('data', b => { output += b; }); p.stderr.on('data', b => { output += b; });
      p.stdin.on('error', () => {}); p.stdin.end(env[name]);
      p.once('error', reject); p.once('exit', code => code === 0 ? resolvePromise() : reject(Error(`Could not configure ${name}. CLI exit ${code}; no secret was logged.`)));
    });
    console.log(`${name}: configured in ZecPaid production.`);
  }
}
async function serve() {
  await initialize();
  const csrf = randomBytes(24).toString('hex');
  const escape = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const html = message => `<!doctype html><html lang="pt-BR"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZecPaid | Configuracao local</title><style>body{margin:0;padding:35px 20px;background:#101211;color:#f3eedc;font:17px/1.5 system-ui}main{max-width:620px;margin:auto}h1{color:#f5c344}label{display:block;margin:22px 0 7px}input{box-sizing:border-box;width:100%;padding:14px;background:#080b07;border:1px solid #737958;color:#fff;font:16px monospace}button{margin-top:27px;padding:15px 25px;background:#f5c344;color:#101211;border:5px double #101211;font:bold 18px system-ui;cursor:pointer}p{color:#bfc5ae}strong{color:#ffe098}small{display:block;color:#a9b295;margin-top:20px}.notice{padding:16px;border:2px solid #8b8c55;color:#ffe098}</style><main><h1>ZecPaid: conectar ao X</h1><p>Esta pagina roda somente neste computador. As credenciais ficam no arquivo privado de ambiente e nao aparecem no site publico.</p>${message ? `<p class="notice">${escape(message)}</p>` : ''}<form method="post" action="/configure"><input type="hidden" name="csrf" value="${csrf}"><label for="client">OAuth 2.0 Client ID</label><input id="client" name="X_CLIENT_ID" autocomplete="off" required><label for="secret">OAuth 2.0 Client Secret</label><input id="secret" name="X_CLIENT_SECRET" type="password" autocomplete="new-password" required><label for="bearer">Novo Bearer Token</label><input id="bearer" name="X_BEARER_TOKEN" type="password" autocomplete="new-password" required><button>Guardar credenciais localmente</button></form><small>Nao use Consumer Key no campo Client ID. Regenere as chaves que apareceram no print antes de continuar. Nenhuma transacao financeira sera liberada por este formulario.</small></main></html>`;
  const server = createServer(async (req,res) => {
    res.setHeader('Content-Type','text/html; charset=utf-8'); res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"); res.setHeader('X-Content-Type-Options','nosniff');
    if (req.headers.host !== '127.0.0.1:5281') { res.writeHead(403); return res.end('Invalid host.'); }
    if (req.method === 'GET' && req.url === '/') return res.end(html(''));
    if (req.method !== 'POST' || req.url !== '/configure' || req.headers.origin !== 'http://127.0.0.1:5281') { res.writeHead(403); return res.end('Request refused.'); }
    let body = '', size = 0;
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 20000) throw Error('Formulario muito grande.'); body += chunk; }
      const form = new URLSearchParams(body), token = form.get('csrf') || '';
      if (token.length !== csrf.length || !timingSafeEqual(Buffer.from(token),Buffer.from(csrf))) throw Error('Reabra esta pagina antes de continuar.');
      const env = await readEnv();
      for (const name of ['X_CLIENT_ID','X_CLIENT_SECRET','X_BEARER_TOKEN']) {
        const value = form.get(name)?.trim();
        if (!value || value.length > 3000 || /\s/.test(value)) throw Error(`Confira o campo ${name}.`);
        env[name] = value;
      }
      await store(env);
      console.log('X credentials entered locally. Values were not logged.');
      res.end(html('Credenciais guardadas. Avise no chat apenas que terminou, sem enviar os valores.'));
    } catch (e) { res.writeHead(400); res.end(html(e.message)); }
  });
  server.listen(5281,'127.0.0.1', () => console.log('Local credential form: http://127.0.0.1:5281/'));
}
const mode = process.argv[2];
if (mode === 'init') await initialize();
else if (mode === 'push') await push(process.argv.slice(3));
else if (mode === 'serve') await serve();
else if (mode === 'url') { const env = await readEnv(); env.PUBLIC_URL = new URL(process.argv[3]).origin; await store(env); console.log('PUBLIC_URL updated locally.'); }
else if (mode === 'status') { const env = await readEnv(); console.log(JSON.stringify(Object.fromEntries(ownKeys.map(k => [k, Boolean(env[k])])), null, 2)); }
else throw Error('Use init, serve, status, url <origin>, or push <variable names>.');
