import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Rocket, Radio, Wallet, Code2, BookOpen, X, ArrowRight, Search, Upload, RefreshCw, Copy, Check, ExternalLink, Save, LogOut, AlertCircle, ChevronRight, Github, Mail, LockKeyhole, Plus, ShieldCheck } from 'lucide-react';
import { PixelIntro } from './PixelIntro.jsx';
import project from '../shared/project.json';
import './styles.css';

const mascot = '/brand/zecpaid-mascot-transparent.png';
const tabs = [
  { id: 'create', label: 'Create a coin', short: 'Create', icon: Rocket },
  { id: 'live', label: 'Live launches', short: 'Live', icon: Radio },
  { id: 'payouts', label: 'My ZEC', short: 'My ZEC', icon: Wallet },
  { id: 'fund', label: 'Builders\' fund', short: 'Fund', icon: Code2 },
  { id: 'docs', label: 'Docs', short: 'Docs', icon: BookOpen }
];
async function api(path, options = {}) {
  const r = await fetch(`/api${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const body = await r.json().catch(() => ({ error: 'The server returned an unreadable response.' }));
  if (!r.ok) throw Error(body.error || 'This request could not be completed.');
  return body;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });
const shorten = value => value ? `${value.slice(0, 6)}…${value.slice(-5)}` : '—';
const date = value => new Date(Number(value)).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function amount(raw, decimals = 8) { if (raw == null) return '—'; const s = String(raw).padStart(decimals + 1, '0'); return `${s.slice(0, -decimals)}.${s.slice(-decimals).replace(/0+$/, '') || '00'}`; }

function IconButton({ icon: Icon, label, onClick, disabled = false, className = '' }) {
  return <button className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}><Icon size={20} /></button>;
}
function CopyButton({ value, notify }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (copied) { const t = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(t); } }, [copied]);
  return <IconButton icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy address'} onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { notify('The clipboard is unavailable. Select the address to copy it.'); } }} />;
}
function Modal({ title, children, close }) {
  const box = useRef(null), closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement;
    box.current.querySelector('button,input,select,textarea,a')?.focus();
    const onKey = e => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const nodes = [...box.current.querySelectorAll('button:not(:disabled),input,textarea,select,a[href]')];
        const first = nodes[0], last = nodes.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><section ref={box} className="modal double-frame" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><h2 id="dialog-title">{title}</h2><IconButton icon={X} label="Close dialog" onClick={close} /></header><div className="modal-body">{children}</div></section></div>;
}
function SocialLinks({ config }) {
  const github = config?.github || project.github;
  return <div className="social-links"><a href={project.x} title="ZecPaid on X" aria-label="ZecPaid on X" target="_blank" rel="noreferrer"><XBrand /><span>@zecpaid</span></a>{github ? <a href={github} title="ZecPaid source on GitHub" aria-label="ZecPaid source on GitHub" target="_blank" rel="noreferrer"><Github size={18} /><span>GitHub</span></a> : <span className="social-pending" title="The repository address is awaiting confirmation"><Github size={18} /><span>GitHub</span></span>}</div>;
}
function Notice({ children }) { return <div className="notice"><AlertCircle size={18} /><span>{children}</span></div>; }
function Empty({ icon: Icon = Mail, title, children, action }) { return <div className="empty"><Icon size={36} strokeWidth={1.4} /><h3>{title}</h3><p>{children}</p>{action}</div>; }

function App() {
  const captureMode = new URLSearchParams(location.search).get('capture') === '1';
  const [tab, setTab] = useState('create'), [status, setStatus] = useState(null), [me, setMe] = useState(null), [toast, setToast] = useState('');
  const [intro, setIntro] = useState(() => !sessionStorage.getItem('zecpaid-intro-v2'));
  const [modal, setModal] = useState(null), [busy, setBusy] = useState('');
  const [username, setUsername] = useState(''), [recipient, setRecipient] = useState(null);
  const [form, setForm] = useState({ name: '', symbol: '', description: '', image: '' }), [saved, setSaved] = useState(null), [savedProjects, setSavedProjects] = useState([]);
  const [launches, setLaunches] = useState([]), [launchError, setLaunchError] = useState(''), [launchLoading, setLaunchLoading] = useState(false), [search, setSearch] = useState('');
  const [balance, setBalance] = useState(null), [treasury, setTreasury] = useState(null), [balanceError, setBalanceError] = useState('');
  const [nominations, setNominations] = useState([]), [nominationError, setNominationError] = useState(''), [nomination, setNomination] = useState({ repo: '', reason: '' });
  const [destination, setDestination] = useState(''), [plan, setPlan] = useState(null);
  const [doc, setDoc] = useState('route');
  const mainRef = useRef(null), uploadRef = useRef(null);
  const finishIntro = React.useCallback(() => { sessionStorage.setItem('zecpaid-intro-v2', '1'); setIntro(false); }, []);
  const refreshStatus = React.useCallback(async () => {
    const value = await api('/status', { cache: 'no-store' });
    setStatus(value);
    return value;
  }, []);
  useEffect(() => {
    refreshStatus().catch(e => setToast(e.message));
    api('/me').then(setMe).catch(e => setToast(e.message));
    if (new URLSearchParams(location.search).has('signed')) history.replaceState(null, '', location.pathname);
    const onFocus = () => { if (!document.hidden) refreshStatus().catch(() => {}); };
    window.addEventListener('focus', onFocus);
    const timer = setInterval(onFocus, 30000);
    return () => { window.removeEventListener('focus', onFocus); clearInterval(timer); };
  }, [refreshStatus]);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(''), 6500); return () => clearTimeout(timer); } }, [toast]);
  useEffect(() => { mainRef.current?.scrollTo(0, 0); if (tab === 'live') refreshLaunches(); if (tab === 'fund') refreshFund(); if (tab === 'payouts' && me) refreshBalance(); }, [tab, me?.id]);
  const run = async (key, fn) => { if (busy) return; setBusy(key); try { return await fn(); } catch (e) { setToast(e.message); } finally { setBusy(''); } };
  function signIn() { if (status?.oauthReady) location.assign('/api/auth/start'); else setModal('connect'); }
  function requireLogin() { if (!me) { signIn(); return false; } return true; }
  async function refreshLaunches() { setLaunchLoading(true); setLaunchError(''); try { setLaunches(await api('/launches')); } catch (e) { setLaunchError(e.message); } finally { setLaunchLoading(false); } }
  async function refreshBalance() { setBalanceError(''); try { setBalance(await api('/balances/me')); } catch (e) { setBalanceError(e.message); } }
  async function refreshFund() { setBalanceError(''); setNominationError(''); try { setTreasury(await api('/treasury')); } catch (e) { setBalanceError(e.message); } try { setNominations(await api('/nominations')); } catch (e) { setNominationError(e.message); } }
  async function lookup(e) { e.preventDefault(); await run('lookup', async () => { setRecipient(null); setSaved(null); const value = await api(`/accounts/${encodeURIComponent(username.trim().replace(/^@/, ''))}`); setRecipient(value); setUsername(`@${value.username}`); }); }
  function update(key, value) { setForm(p => ({ ...p, [key]: value })); setSaved(null); }
  async function upload(e) {
    const file = e.target.files?.[0]; if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) { setToast('Choose a PNG, JPEG or WebP smaller than 2 MiB.'); e.target.value = ''; return; }
    const reader = new FileReader(); reader.onload = () => update('image', reader.result); reader.readAsDataURL(file);
  }
  async function saveToken(e) {
    e.preventDefault(); if (!requireLogin()) return;
    if (!recipient) return setToast('Look up the recipient on X first.');
    await run('save', async () => { const value = await post('/projects', { ...form, username: recipient.username, recipientId: recipient.id }); setSaved(value); setToast(`${value.name} saved to your account.`); });
  }
  async function reviewLaunch() {
    if (!requireLogin()) return;
    if (!saved) return setToast('Save the token details before preparing its launch.');
    await run('prepare', async () => { const value = await post(`/projects/${saved.id}/prepare`); setPlan(value); setModal('review'); });
  }
  const activeTitle = { create: 'New token', live: 'Live launches', payouts: 'My ZEC', fund: 'Builders\' fund', docs: 'How ZecPaid works' }[tab];
  return <>
    {intro && <PixelIntro done={finishIntro} />}
    <div className={`app-shell ${!intro ? 'app-enter' : ''} ${captureMode ? 'capture-mode' : ''}`} inert={intro ? true : undefined}>
      <header className="topbar">
        <button className="brand" aria-label="ZecPaid, create a coin" onClick={() => setTab('create')}><img src={mascot} alt="" /><span>ZecPaid<span className="brand-note">Pay the builders.</span></span></button>
        <div className="header-contract"><span>CA: <strong>{status?.mainToken ? shorten(status.mainToken) : 'SOON'}</strong></span>{status?.mainToken && <CopyButton value={status.mainToken} notify={setToast} />}</div>
        {me ? <button className="square-button account-button" onClick={() => setModal('account')}><span className="account-dot" />@{me.username}<ChevronRight size={19} /></button> : <button className="square-button primary connect-button" onClick={signIn}><XBrand /><span>Connect X</span><ArrowRight size={19} /></button>}
      </header>
      <div className="workspace">
        <nav className="sidebar" aria-label="Launchpad navigation">
          <div className="nav-list">{tabs.map(t => <button key={t.id} className={`nav-button ${tab === t.id ? 'selected' : ''}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)} title={t.label}><t.icon size={23} /><span className="nav-long">{t.label}</span><span className="nav-short">{t.short}</span><ChevronRight className="nav-arrow" size={17} /></button>)}</div>
          <div className="sidebar-bottom"><div className="quote-mark">ZEC</div><p>One account.<br />One fee wallet.</p><SocialLinks config={status} /></div>
        </nav>
        <main className="main" id="main">
          <header className="page-header"><div><div className="breadcrumb">ZecPaid <ChevronRight size={13} /> {tabs.find(t => t.id === tab).short}</div><h1>{activeTitle}</h1></div><div className="page-tools">{tab === 'create' && <button className="text-button" onClick={() => { if (!requireLogin()) return; run('projects', async () => { setSavedProjects(await api('/projects')); setModal('projects'); }); }}><BookOpen size={18} /> My projects</button>}{tab === 'live' && <IconButton icon={RefreshCw} label="Refresh launches" onClick={refreshLaunches} disabled={launchLoading} />}{tab === 'fund' && <IconButton icon={RefreshCw} label="Refresh fund" onClick={refreshFund} />}{tab === 'payouts' && me && <IconButton icon={RefreshCw} label="Refresh balance" onClick={refreshBalance} />}{tab === 'docs' && doc === 'setup' && <IconButton icon={RefreshCw} label="Refresh service status" onClick={() => run('status', refreshStatus)} disabled={busy === 'status'} />}</div></header>
          <div className="page-content" ref={mainRef} key={tab}>
            {tab === 'create' && <div className="create-grid">
              <section className="token-editor">
                <form className="recipient-form" onSubmit={lookup}><label htmlFor="recipient">Who receives the creator fees?</label><div className="lookup-row"><label className="handle-input" htmlFor="recipient"><span aria-hidden="true"><XBrand /></span><input id="recipient" aria-label="Recipient X username" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} onChange={e => { setUsername(e.target.value); setRecipient(null); setSaved(null); }} maxLength={16} placeholder="@username" required pattern="@?[a-zA-Z0-9_]{1,15}" /></label><button className="square-button primary lookup-button" disabled={busy === 'lookup'}><Search size={21} /><span>{busy === 'lookup' ? 'Finding…' : 'Find'}</span></button></div></form>
                <form className="token-form" onSubmit={saveToken}>
                  <div className="token-form-body">
                  <div className="token-fields"><div className="field"><label htmlFor="token-name">Token name</label><input id="token-name" value={form.name} onChange={e => update('name', e.target.value)} maxLength={32} placeholder="Name your coin" required /></div><div className="field"><label htmlFor="ticker">Ticker</label><div className="ticker-input"><span>$</span><input id="ticker" value={form.symbol} onChange={e => update('symbol', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))} maxLength={10} placeholder="TICKER" required /></div></div></div>
                  <div className="art-description"><div className="image-field"><label>Token image</label><button className={`upload-button ${form.image ? 'has-image' : ''}`} type="button" onClick={() => uploadRef.current.click()} aria-label={form.image ? 'Change token image' : 'Upload token image'}>{form.image ? <img src={form.image} alt="Your token artwork" /> : <><Upload size={29} /><span>Add image</span></>}</button><input ref={uploadRef} className="visually-hidden" aria-label="Token image file" type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} /><small>PNG / JPG / WEBP</small></div><div className="field"><label htmlFor="description">About this coin</label><textarea id="description" value={form.description} onChange={e => update('description', e.target.value)} minLength={10} maxLength={500} placeholder="What are you supporting?" required /><small>{form.description.length}/500</small></div></div>
                  <div className="route-lines"><div><span>Pair asset</span><strong><span className="zec-glyph">Z</span> ZEC <small>Solana</small></strong></div><div><span>Creator fee destination</span><strong>{recipient ? `@${recipient.username}` : 'Choose an X account'}</strong></div><div><span>Beneficiary's share</span><strong>100% <small>of creator fees</small></strong></div></div>
                  </div>
                  <div className="form-actions"><button className="square-button secondary" disabled={!!busy}><Save size={20} />{busy === 'save' ? 'Saving…' : saved ? 'Saved' : 'Save token'}</button><button className="square-button primary" type="button" onClick={reviewLaunch} disabled={!!busy}><Rocket size={21} />{busy === 'prepare' ? 'Preparing…' : 'Review launch'}</button></div>
                  <p className="fine-print">A community-created coin does not imply endorsement by its beneficiary. Protocol and LP fees are separate.</p>
                </form>
              </section>
              <aside className="recipient-desk">
                <div className="recipient-heading"><span className="tiny-square" /> Fee recipient <span className="desk-status">{recipient ? 'X identity verified' : 'Not selected'}</span></div>
                {recipient ? <div className="recipient-result"><div className="recipient-avatar">{recipient.avatar ? <img src={recipient.avatar} alt="" /> : <span>@</span>}</div><h2>{recipient.name}</h2><a href={`https://x.com/${recipient.username}`} target="_blank" rel="noreferrer">@{recipient.username} <ExternalLink size={14} /></a><div className="identity-record"><span>Permanent X ID</span><strong>{recipient.id}</strong></div>{recipient.wallet && <div className="identity-record"><span>Fee wallet</span><div><code>{shorten(recipient.wallet)}</code><CopyButton value={recipient.wallet} notify={setToast} /></div></div>}<p>Every ZecPaid coin supporting this account uses the same fee wallet.</p></div> : <div className="courier-scene"><div className="scene-dots" /><img src={mascot} alt="ZecPaid's golden receipt messenger holding an envelope" /><div className="floor-tile" /><div className="scene-caption"><h2>Pick the person.<br />They get the fees.</h2><p>A builder's X account is the destination.</p></div></div>}
                <div className="route-explanation"><span className="route-node"><Rocket size={20} />Coin</span><ArrowRight size={18} /><span className="route-node"><Wallet size={20} />Fee wallet</span><ArrowRight size={18} /><span className="route-node"><LockKeyhole size={20} />Claim</span></div>
                <button className="text-button route-help" onClick={() => { setDoc('route'); setTab('docs'); }}>Where does the ZEC go? <ChevronRight size={16} /></button>
              </aside>
            </div>}
            {tab === 'live' && <section className="live-view"><div className="section-toolbar"><div className="search-input"><Search size={19} /><input aria-label="Search launches" placeholder="Search a coin or @builder" value={search} onChange={e => setSearch(e.target.value)} /></div><span>{launches.length} finalized</span></div>{launchError && <Notice>{launchError}</Notice>}{launchLoading ? <Empty icon={RefreshCw} title="Checking the registry">Reading finalized launch records.</Empty> : launches.length === 0 ? <Empty icon={Rocket} title="The first launch belongs here.">A coin appears after its creation transaction is finalized on Solana.<button className="square-button primary" onClick={() => setTab('create')}><Plus size={20} />Create a coin</button></Empty> : <div className="launch-table"><div className="table-heading"><span>Coin / recipient</span><span>Pair</span><span>Launch receipt</span></div>{launches.filter(l => `${l.name} ${l.symbol} ${l.username}`.toLowerCase().includes(search.toLowerCase())).map(l => <article className="launch-row" key={l.mint}><div><img src={`/api/images/${l.id}`} alt="" /><div><strong>{l.name} <span>${l.symbol}</span></strong><a href={`https://x.com/${l.username}`} target="_blank" rel="noreferrer">@{l.username}</a></div></div><span>ZEC</span><div><a className="text-button" href={`https://solscan.io/tx/${l.signature}`} target="_blank" rel="noreferrer">Receipt <ExternalLink size={16} /></a><a className="square-button secondary" href={`https://pump.fun/coin/${l.mint}`} target="_blank" rel="noreferrer">Open coin <ArrowRight size={16} /></a></div></article>)}</div>}</section>}
            {tab === 'payouts' && <section className="payout-view">{!me ? <div className="account-gate"><img src={mascot} alt="ZecPaid courier" /><div><h2>This wallet belongs to your X account.</h2><p>Sign in with X to find the fee wallet linked to your permanent account ID.</p><button className="square-button primary" onClick={signIn}><XBrand />Connect X<ArrowRight size={20} /></button></div></div> : <div className="payout-grid"><section><div className="balance-heading"><Wallet size={23} /><span>@{me.username}'s wallet</span></div><div className="large-balance">{amount(balance?.zecRaw)}<span>ZEC</span></div><p className="muted">Finalized wallet balance. Deposits are not automatically attributed to token fees.</p><div className="address-line"><code>{me.wallet}</code><CopyButton value={me.wallet} notify={setToast} /></div>{balanceError && <Notice>{balanceError}</Notice>}<div className="route-lines"><div><span>Network costs</span><strong>{amount(balance?.solLamports, 9)} SOL</strong></div><div><span>Last checked</span><strong>{balance ? date(balance.checked) : 'Refresh to check'}</strong></div></div></section><section className="claim-panel"><h2>Claim destination</h2><p>Use a separate Solana address for the withdrawal.</p><label htmlFor="destination">Your receiving address</label><input id="destination" value={destination} onChange={e => setDestination(e.target.value)} placeholder="Solana public address" autoComplete="off" /><button className="square-button primary" onClick={() => run('claim', async () => { await post('/claims', { destination }); })} disabled={!!busy || !destination}><LockKeyhole size={20} />Check private withdrawal</button><p className="fine-print">The Privacy Cash payout service still needs funded testing. Funds stay in the managed fee wallet until a supported withdrawal is available.</p></section></div>}</section>}
            {tab === 'fund' && <section className="fund-view"><div className="fund-summary"><div><div className="balance-heading"><Code2 size={24} /><span>The ZecPaid main-token fund</span></div><h2>Good code deserves backing.</h2><p>Main-token creator fees are intended for developer grants. They are separate from fees owed to each coin's X beneficiary.</p><div className="address-line"><code>{project.treasury}</code><CopyButton value={project.treasury} notify={setToast} /></div><a href={`https://solscan.io/account/${project.treasury}`} target="_blank" rel="noreferrer" className="text-button">Inspect treasury <ExternalLink size={15} /></a></div><div className="fund-balance"><span>Observed ZEC</span><strong>{amount(treasury?.zecRaw)}</strong><small>{treasury ? date(treasury.checked) : 'Checking public balance'}</small><span className="fund-sol">{amount(treasury?.solLamports, 9)} SOL</span></div></div>{balanceError && <Notice>{balanceError}</Notice>}<div className="section-toolbar"><h2>Projects to review</h2><button className="square-button primary" onClick={() => { if (requireLogin()) setModal('nominate'); }}><Github size={20} />Nominate a repo</button></div>{nominationError && <Notice>{nominationError}</Notice>}{nominations.length ? <div className="nomination-list">{nominations.map(n => <article key={n.id}><Github size={25} /><div><a href={n.repo} target="_blank" rel="noreferrer">{n.name}<ExternalLink size={14} /></a><p>{n.description}</p><blockquote>{n.reason}</blockquote></div><span>Awaiting review</span></article>)}</div> : <Empty icon={Code2} title="Show us something useful.">Nominate a public GitHub repository with working code and explain what it does. A nomination is not a grant award.</Empty>}</section>}
            {tab === 'docs' && <div className="docs-grid"><nav aria-label="Documentation topics" className="docs-nav">{[['route', 'Fee route'], ['identity', 'X accounts'], ['privacy', 'Privacy & custody'], ['launch', 'Token launches'], ['grants', 'Builder grants'], ['setup', 'Operator setup']].map(([id, label]) => <button key={id} className={doc === id ? 'active' : ''} onClick={() => setDoc(id)}>{label}<ChevronRight size={16} /></button>)}</nav><article className="doc-copy">
              {doc === 'route' && <><h2>Follow the creator's share.</h2><p>Choose an X account as a beneficiary. A ZEC-paired coin assigns its creator-fee recipient to that account's dedicated managed wallet. Other ZecPaid coins for the same account reuse it.</p><h3>What “100%” means</h3><p>The beneficiary receives the creator's share. Pump's protocol fees and liquidity-provider fees are not part of that share. Network and private-relay costs must be shown before a supported withdrawal.</p><h3>Accrued isn't received</h3><p>Fees can remain on a bonding curve or pool until swept and collected. Wallet balances alone do not prove how much a particular coin earned. Automated fee sweeps have not been deployed.</p><a href="https://pump.fun/docs/fees" target="_blank" rel="noreferrer">Pump fee schedule <ExternalLink size={15} /></a></>}
              {doc === 'identity' && <><h2>A handle can change. The owner shouldn't.</h2><p>ZecPaid resolves the numeric account ID through the X API. That ID, not the display name or @username, owns the fee-wallet record.</p><p>Only X OAuth sign-in can establish account ownership. Typing a username, connecting a Solana wallet or posting a screenshot does not unlock that account.</p><h3>No endorsement implied</h3><p>Anyone can propose a coin supporting an account. That does not mean the beneficiary launched, approved or promoted it. Unclaimed funds need the beneficiary's verified X login.</p><p>X controls its account access and recovery. A compromised X account can compromise access here. Managed custody adds operator risk.</p></>}
              {doc === 'privacy' && <><h2>Private payout, public launch.</h2><p>The pair asset is bridged ZEC on Solana, not native shielded Zcash. Token creation, trading, fee wallets and incoming transfers remain public.</p><p>The intended withdrawal route is Privacy Cash to a separate destination. It does not make every amount, timing detail or service-side identity private. Sending back to the public fee wallet would defeat the separation.</p><h3>Who holds the keys?</h3><p>The service generates one collector wallet per verified X account and encrypts its key with account-bound authenticated encryption. This is managed custody, not a non-custodial vault. Do not send funds before the operator completes the custody and payout review.</p><p>Private payout is not enabled. No public-transfer fallback silently replaces it.</p><a href="https://github.com/Privacy-Cash/privacy-cash-sdk" target="_blank" rel="noreferrer">Privacy Cash SDK <ExternalLink size={15} /></a></>}
              {doc === 'launch' && <><h2>A saved coin isn't an issued coin.</h2><p>Token details and artwork are stored in your account. The launch builder uses official Pump instructions, the pinned ZEC mint, and the verified beneficiary wallet. It includes no initial token purchase.</p><p>Launch preparation freezes the metadata. A review shows the payer, creator-fee recipient and simulated SOL costs. Explicit confirmation is required before the managed funding wallet signs.</p><p>Signed bytes and their signature are stored before broadcast. An uncertain response stays pending; a matching, successful finalized transaction is required before the coin appears in Live launches.</p><p>Signing remains gated pending funded acceptance testing and security review. Buying or creating tokens involves loss risk; fees are not guaranteed revenue.</p><a href="https://pump.fun/docs/custom-pairs" target="_blank" rel="noreferrer">Supported pair assets <ExternalLink size={15} /></a><div className="address-line"><code>{project.zecMint}</code><CopyButton value={project.zecMint} notify={setToast} /></div></>}
              {doc === 'grants' && <><h2>Review the work, not the follower count.</h2><p>The main ZecPaid token's creator fees are intended for a separate developer fund. Fees assigned to other beneficiaries are not available for these grants.</p><p>Nominations require a public, unarchived GitHub repository. Reviews should examine runnable software, maintenance, originality, licensing and a specific proposed use of the grant.</p><p>No automatic star ranking, invented winners or guaranteed awards. Funded grants require published criteria, a justified operator decision and a verifiable payment receipt. No grants have been paid by this release.</p></>}
              {doc === 'setup' && <><h2>Connect the actual services.</h2><p>Visitors use the browser. They do not install a ZecPaid extension or desktop app. The operator needs an X Developer application and API access.</p><div className="setup-list">{[['Dedicated database', status?.storage], ['X OAuth credentials', status?.oauthReady], ['X profile API', status?.lookupReady], ['Encrypted wallet vault', status?.vaultReady], ['Funded launch acceptance', status?.launchReady], ['Private payout relay', status?.privatePayoutReady]].map(([name, ready]) => <div key={name}><span>{name}</span><strong className={ready ? 'ready' : ''}>{!status ? 'Checking' : ready ? 'Configured' : 'Required'}</strong></div>)}</div>{status?.checkedAt && <p className="service-check-time">Checked {date(status.checkedAt)}</p>}<h3>X callback URL</h3><div className="address-line"><code>{status?.callbackUrl || `${location.origin}/api/auth/callback`}</code><CopyButton value={status?.callbackUrl || `${location.origin}/api/auth/callback`} notify={setToast} /></div><p>OAuth needs a confidential Web App with PKCE. No posting, follow or DM permissions are requested. Secrets belong in server environment variables, never in this page or a chat.</p><a href="https://developer.x.com/" target="_blank" rel="noreferrer">X Developer Console <ExternalLink size={15} /></a></>}
            </article></div>}
          </div>
        </main>
      </div>
      <footer className="statusbar"><span><i />Solana mainnet <b>/</b> ZEC pair</span><span className="footer-status">{status ? status.oauthReady ? 'X sign-in configured' : 'X app registration required' : 'Connecting to services…'}</span><div className="mobile-social"><SocialLinks config={status} /></div><button onClick={() => { setDoc('privacy'); setTab('docs'); }}><ShieldCheck size={13} /> Custody & privacy</button></footer>
    </div>
    {toast && <div className="toast" role="status"><AlertCircle size={19} /><span>{toast}</span><IconButton icon={X} label="Dismiss notification" onClick={() => setToast('')} /></div>}
    {modal === 'connect' && <Modal title="Connect your X account" close={() => setModal(null)}><div className="connect-emblem"><XBrand /></div><p>The ZecPaid X application still needs to be registered by the operator. Its OAuth credentials are what let X verify who owns an account.</p><p>You won't need an extension, a seed phrase or a new install.</p><button className="square-button primary" onClick={() => { setModal(null); setDoc('setup'); setTab('docs'); }}>View setup <ChevronRight size={20} /></button></Modal>}
    {modal === 'account' && me && <Modal title={`@${me.username}`} close={() => setModal(null)}><p>Permanent X ID: <strong>{me.id}</strong></p><label>Managed fee wallet</label><div className="address-line"><code>{me.wallet}</code><CopyButton value={me.wallet} notify={setToast} /></div><Notice>Do not deposit funds until the custody and private-payout review is complete.</Notice><button className="square-button secondary" onClick={() => run('logout', async () => { await post('/auth/logout'); setMe(null); setBalance(null); setSaved(null); setModal(null); })}><LogOut size={20} />Sign out</button></Modal>}
    {modal === 'projects' && <Modal title="My saved projects" close={() => setModal(null)}>{savedProjects.length ? <div className="saved-list">{savedProjects.map(p => <div key={p.id}><div><strong>{p.name} <span>${p.symbol}</span></strong><p>For @{p.username}</p></div><button className="square-button secondary" onClick={() => { setSaved(p); setModal(null); run('prepare', async () => { const value = await post(`/projects/${p.id}/prepare`); setPlan(value); setModal('review'); }); }}>Review launch</button></div>)}</div> : <Empty icon={BookOpen} title="No saved coins yet.">Your saved token details will appear here.</Empty>}</Modal>}
    {modal === 'nominate' && <Modal title="Nominate a builder's project" close={() => setModal(null)}><form className="nominate-form" onSubmit={e => { e.preventDefault(); run('nominate', async () => { await post('/nominations', nomination); setModal(null); setNomination({ repo: '', reason: '' }); setToast('Repository verified and submitted for review.'); refreshFund(); }); }}><div className="field"><label htmlFor="repo">Public GitHub repository</label><input id="repo" type="url" value={nomination.repo} onChange={e => setNomination(p => ({ ...p, repo: e.target.value }))} required placeholder="https://github.com/owner/repository" /></div><div className="field"><label htmlFor="reason">What works, and why should it be funded?</label><textarea id="reason" value={nomination.reason} onChange={e => setNomination(p => ({ ...p, reason: e.target.value }))} minLength={30} maxLength={1000} required /></div><button className="square-button primary" disabled={!!busy}><Github size={20} />{busy === 'nominate' ? 'Verifying repository…' : 'Submit for review'}</button></form></Modal>}
    {modal === 'review' && plan && <Modal title="Review token launch" close={() => setModal(null)}><div className="route-lines">{[['Token', `${plan.review?.name} ($${plan.review?.symbol})`], ['Beneficiary', `@${plan.review?.recipientUsername}`], ['Pair', 'ZEC on Solana'], ['Creator-fee wallet', plan.review?.creatorFeeRecipient], ['Maximum simulated SOL cost', amount(plan.review?.simulatedCostLamports, 9)], ['Initial purchase', 'None']].map(([k,v]) => <div key={k}><span>{k}</span><strong className="breakable">{v}</strong></div>)}</div><Notice>This creates a public token using your managed wallet. It does not give it value or imply the beneficiary's endorsement.</Notice>{plan.status === 'prepared' ? <button className="square-button primary" disabled={!!busy} onClick={() => run('confirm', async () => { const result = await post(`/plans/${plan.id}/confirm`); setPlan(p => ({ ...p, ...result })); setToast(result.message || `Launch status: ${result.status}`); })}><Rocket size={20} />Confirm and sign</button> : <><p>Receipt: <strong>{plan.status}</strong></p>{plan.signature && <a href={`https://solscan.io/tx/${plan.signature}`} target="_blank" rel="noreferrer">Inspect transaction <ExternalLink size={15} /></a>}<button className="square-button secondary" onClick={() => run('check', async () => { const result = await post(`/plans/${plan.id}/check`); setPlan(p => ({ ...p, ...result })); })}><RefreshCw size={20} />Check finalization</button></>}</Modal>}
  </>;
}
function XBrand() { return <span className="x-brand" aria-hidden="true">𝕏</span>; }
createRoot(document.getElementById('root')).render(<App />);
