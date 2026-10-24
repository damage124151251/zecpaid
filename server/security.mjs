import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
export class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const random = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const pkce = value => createHash('sha256').update(value).digest('base64url');
export function equal(a, b) { const x = Buffer.from(a || ''), y = Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x, y); }
export function keyReady(key = process.env.CUSTODY_ENCRYPTION_KEY) { return typeof key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, 'base64').length === 32; }
function master(key) { if (!keyReady(key)) throw new AppError('The encrypted wallet vault has not been configured.', 503); return Buffer.from(key, 'base64'); }
export function seal(value, binding, key = process.env.CUSTODY_ENCRYPTION_KEY) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master(key), nonce);
  cipher.setAAD(Buffer.from(`zecpaid:${binding}`));
  return [nonce, Buffer.concat([cipher.update(value), cipher.final()]), cipher.getAuthTag()].map(b => b.toString('base64url')).join('.');
}
export function unseal(value, binding, key = process.env.CUSTODY_ENCRYPTION_KEY) {
  const parts = value.split('.');
  if (parts.length !== 3 || parts.some(p => !p || Buffer.from(p, 'base64url').toString('base64url') !== p)) throw new AppError('Invalid encrypted wallet envelope.', 409);
  const [nonce, encrypted, tag] = parts.map(p => Buffer.from(p, 'base64url'));
  if (nonce.length !== 12 || tag.length !== 16) throw new AppError('Invalid encrypted wallet envelope.', 409);
  const cipher = createDecipheriv('aes-256-gcm', master(key), nonce);
  cipher.setAAD(Buffer.from(`zecpaid:${binding}`)); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]);
}
export function handle(value) {
  const name = String(value || '').trim().replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(name)) throw new AppError('Enter an X username, such as @yourname.');
  return name;
}
export function text(value, label, min, max) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length < min || result.length > max || /[\x00-\x08\x0b-\x1f]/.test(result)) throw new AppError(`${label} must contain ${min}-${max} characters.`);
  return result;
}
export function origin(req) {
  const configured = process.env.PUBLIC_URL;
  if (configured) return new URL(configured).origin;
  const hosted = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (process.env.VERCEL && hosted) return new URL(`https://${hosted}`).origin;
  if (process.env.VERCEL) throw new AppError('The public site address has not been configured.', 503);
  return 'http://127.0.0.1:5278';
}
export function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(p => p.trim().split('=')).filter(p => p.length === 2));
}
export function cookie(res, name, value, age) {
  res.append('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${process.env.VERCEL || process.env.PUBLIC_URL?.startsWith('https:') ? '; Secure' : ''}`);
}
export function sameOrigin(req) { if (req.headers.origin !== origin(req)) throw new AppError('Reload ZecPaid before trying this action again.', 403); }
