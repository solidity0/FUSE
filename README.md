# FUSE

FUSE is a browser tool for minting NFTs from several wallets at once. Paste a mint link, pick your wallets, and FUSE reads the collection's stages and prices, then mints when you fire or at a scheduled time.

**Use it:** https://solidity0.github.io/FUSE/

> **Early software.** Real mints, allowlist mints and scheduled mints haven't been fully proven on a live network yet. Start with small amounts, and only with funds you can afford to lose.

## Keep your wallets safe

Read this before you add a wallet.

- **You need an account.** FUSE asks you to sign in before it opens.
- **Use dedicated mint wallets.** Don't use your main wallet, and only keep mint funds in these ones.
- **Created and imported wallets are encrypted in your browser,** using your password, then saved to your account so they follow you to other devices. Your password itself is never sent, so nobody else can read them.
- **A forgotten password can't be recovered.** Nobody can reset it or get those wallets back, so keep your own copy of your keys.
- **Signed in means unlocked.** A malicious browser extension allowed on the site could read your keys while FUSE is open, so close the tab or sign out on a shared computer.
- **Connected wallets (MetaMask and others)** keep their own keys. FUSE only saves the address, in your browser.

## How to use it

1. **Wallets:** create, import or connect the wallets you want to use, then tick them.
2. **Fund them:** use Disperse to send ETH to your wallets, or to an outside address.
3. **Mints:** paste a mint link. FUSE shows the stages and which wallets can mint.
4. **Arm, then fire:** Simulate checks the call, Arm gets it ready, and Fire now sends it. Scheduled stages fire by themselves while the page stays open.
5. **History:** past mints and sends are listed with their status and a link to the block explorer. History stays in your browser.

## How it's built

| File | What it does |
|---|---|
| `index.html` | The whole app in one page, served by GitHub Pages from `main` |
| `worker.js` | A Cloudflare Worker for what a browser can't do alone: OpenSea and ABI lookups, an RPC relay and reading mint pages |
| `firestore.rules` | Lets each signed-in user reach only their own encrypted wallets. Publish changes in the Firebase console |
| `wrangler.toml` | Worker settings, including which sites may use it |
| `scripts/csp-hash.mjs` | Keeps the page's security policy in step with its script |

## Development

```bash
npm install
```

**After editing the script in `index.html`,** update the hash in its security policy, or the page won't run:

```bash
npm run csp
```

**To run the worker locally,** put your keys in a `.dev.vars` file, which git ignores:

```bash
npm run dev
```

**To deploy the worker:**

```bash
npx wrangler deploy
```

Set its keys as secrets, and never commit them:

```bash
npx wrangler secret put OPENSEA_API_KEY
```

Merging to `main` deploys the site.
