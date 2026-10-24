# ZecPaid

A single-screen web app for ZEC-paired token projects supporting X accounts.
The beneficiary is pinned by the permanent numeric X ID. One encrypted managed
collector wallet is reused for that account, including after a username change.

- Website: https://zecpaid.vercel.app
- X: https://x.com/zecpaid
- Source: https://github.com/damage124151251/zecpaid

## Run

Node.js 24 is required. Install with `npm ci --ignore-scripts`, configure the
server variables from `.env.example`, then use `npm run dev`.

`npm test` runs explicit fixture-based cryptographic, identity, authorization,
persistence and reconciliation tests. `npm run qa` checks the real frontend at
four viewport sizes. These are not funded mainnet acceptance tests.

## Services and Custody

Production uses an exclusive PostgreSQL database. Local SQLite is a development
fallback, never a production replacement. X OAuth uses browser-bound single-use
state and PKCE S256; API tokens and vault keys remain server-side. Visitors do
not need a custom extension or desktop installation.

`scripts/operator.mjs` initializes an account-bound AES-256-GCM key vault and
provides an optional loopback-only credential form. It is excluded from the web
deployment. Its secrets, local database files, test captures and infrastructure
credentials are excluded from this repository. Do not rotate the vault master
without a reviewed migration and a recoverable backup.

Managed wallets are custodial. An X login is account authentication, not an
authorization to move money. Review each displayed financial action separately.

## Financial Release State

The launch implementation prepares official Pump instructions, pins bridged ZEC
on Solana, simulates costs and stores signed bytes before broadcasting. Only a
matching successful finalized transaction enters the launch registry. There is
no initial token purchase in the launch transaction.

Financial signing is not enabled in the current release. Automated creator-fee
sweeps and the private payout workflow remain unfinished. Do not interpret the
interface, configured API credentials or passing fixture tests as evidence of a
funded launch or payment. No main token, funded grant or completed payout is
invented. The main developer fund is separate from beneficiary-owned funds.

Bridged ZEC on Solana is not native shielded Zcash. Public token creation,
trading, account funding and fee-wallet balances do not become confidential by
using ZEC as the quote asset. No complete anonymity or financial return is
promised.

## Artwork

The golden receipt courier is original generated artwork. Fonts are Jacquard 12
and Pixelify Sans; their OFL notices are included with the font files. The
project is independent of X, Zcash, Pump and Privacy Cash.
