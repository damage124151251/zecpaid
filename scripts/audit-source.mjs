import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { parseEnv } from 'node:util';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const local = parseEnv(readFileSync('.env.local', 'utf8'));
const names = ['DATABASE_URL','CUSTODY_ENCRYPTION_KEY','X_CLIENT_ID','X_CLIENT_SECRET','X_BEARER_TOKEN'];
const secrets = names.filter(n => local[n]?.length > 8).map(n => [n, local[n]]);
if (local.DATABASE_URL) secrets.push(['DATABASE_PASSWORD', decodeURIComponent(new URL(local.DATABASE_URL).password)]);
const findings = [];
for (const file of files) {
  if (/^(?:\.env(?!\.example$)|\.vercel\/|node_modules\/|data\/|test-results\/)/.test(file)) findings.push({ file, reason: 'private or runtime path' });
  if (lstatSync(file).isSymbolicLink()) { findings.push({ file, reason: 'unreviewed symbolic link' }); continue; }
  const bytes = readFileSync(file);
  for (const [kind, value] of secrets) if (value.length > 8 && bytes.includes(Buffer.from(value))) findings.push({ file, reason: `contains ${kind}` });
}
console.log(JSON.stringify({ checkedFiles: files.length, findings }, null, 2));
if (!files.length || findings.length) process.exitCode = 1;
