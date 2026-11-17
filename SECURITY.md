# Security policy

## What this project is

Rookery is a custodial launchpad for meme tokens on Zero, GIWA and Stellar. It holds user
deposits on a hot wallet and moves real funds, so security reports are taken seriously.

## Reporting a vulnerability

Do **not** open a public issue for anything that could move, freeze or leak funds.

- Email: security@stinkypenguin.xyz
- Or open a private security advisory on this repository (Security → Report a vulnerability).

Please include: what you tested, the exact request or transaction, the impact you think it has,
and whether any real user funds were touched. A proof of concept on a fork or testnet is ideal.

We aim to acknowledge within 72 hours. We will not pursue anyone who follows these rules:
test only against your own accounts, never against other users' balances, and never run
automated load tests against production.

## Out of scope

- Spam, rate limiting and missing headers without a demonstrated impact.
- Findings that need the attacker to already hold an admin key, the master seed, or the
  Cloudflare/GitHub credentials.
- Social engineering of the team.

## Secrets

This repository contains **no** keys, seeds or admin tokens. `.master_xprv`, `.master_mnemonic`,
`.admin_key`, `.staging/` and `.dev.vars` are git-ignored and must stay that way. If you ever see
one of them committed, treat it as a critical incident: rotate the key first, then clean history.

## CI guards

Every push runs:

- `node --check` on the worker and site bundles
- a secret scan (`gitleaks`) over the full history
- `npm audit` on the root and `stellar/` workspaces

A red secret scan blocks the merge on purpose.
