/**
 * FUSE Proxy — Cloudflare Worker
 *
 * Why this exists: a pure client-side tool like FUSE can't do three things from the
 * browser, so this tiny worker does them server-side and adds CORS headers:
 *
 *   GET ?collection=<slug|0xaddress>  Everything FUSE shows for a collection in one call:
 *                                     name, images, chain + contract, stats, sample items,
 *                                     and mint progress / stages when OpenSea has a drop.
 *   GET ?slug=<opensea-slug>          OpenSea collection lookup. OpenSea's docs say the
 *                                     API key must never be used client-side, and the
 *                                     API doesn't send CORS headers for arbitrary origins.
 *   GET ?abi=<address>&chainid=<id>   Etherscan v2 getabi, so the Etherscan key can live
 *                                     here instead of in the browser (optional).
 *   POST ?rpc=<chain>                 JSON-RPC relay (e.g. ?rpc=robinhood). Fixes browser CORS
 *                                     and lets a secret like RPC_ROBINHOOD point it at a
 *                                     private RPC. Only normal read/send methods are allowed.
 *   GET ?url=<https://mint-site>      Reads a mint page (plus its first-party scripts,
 *                                     where SPA mint sites keep the contract address) and
 *                                     returns every 0x address found. Browsers can't read
 *                                     other sites' HTML because of CORS.
 *
 * SETUP (about 2 minutes):
 * 1. Go to https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker.
 * 2. Paste this whole file in as the Worker's code, replacing the default.
 * 3. Set secrets so keys are never visible in the source:
 *      wrangler secret put OPENSEA_API_KEY
 *      wrangler secret put ETHERSCAN_API_KEY      (optional — enables ?abi= on Etherscan chains)
 *      wrangler secret put RPC_ROBINHOOD          (optional — your private Robinhood Chain RPC URL)
 *    (or, in the dashboard: Settings -> Variables -> add each as an encrypted secret,
 *    not a plain text variable)
 * 4. Optional but recommended: add a plain variable ALLOWED_ORIGINS with the origin(s)
 *    you open FUSE from, comma-separated (e.g. "https://you.github.io,null" — "null" is
 *    what browsers send for a file:// page). Other origins are then refused, so nobody
 *    else can use your worker (and your OpenSea quota) as an open proxy.
 * 5. Deploy. Copy the worker's URL (looks like
 *    https://fuse-proxy.<your-subdomain>.workers.dev).
 * 6. Paste that URL into FUSE's Settings -> "OpenSea proxy URL" field.
 *    You no longer need to put an OpenSea or Etherscan API key into FUSE itself.
 */

const ADDRESS_RE = /(?<![0-9a-fA-F])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/g;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_SCRIPTS = 8;
const FETCH_TIMEOUT_MS = 8000;

function corsHeadersFor(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Lets a public site (e.g. GitHub Pages) call this worker while it runs locally under
    // `wrangler dev` — Chrome's Private Network Access check asks for this on preflight.
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  };
  if (!allowed.length) headers['Access-Control-Allow-Origin'] = '*';
  else if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return { headers, originAllowed: !allowed.length || (origin && allowed.includes(origin)) };
}

function json(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function fetchWithTimeout(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { redirect: 'follow', ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytes >= MAX_PAGE_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return text;
}

function parsePublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname;
  // Workers can't reach private networks anyway; refuse obvious internal targets outright.
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(10|127|0)\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host.startsWith('[')
  ) {
    return null;
  }
  return u;
}

// Follows redirects by hand so every hop gets the same public-address check as the first URL —
// otherwise a public page could bounce the worker to an internal one.
const MAX_REDIRECTS = 4;
async function fetchPublic(url, init) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchWithTimeout(current.toString(), { ...init, redirect: 'manual' });
    const location = res.status >= 300 && res.status < 400 && res.headers.get('Location');
    if (!location) return { res, url: current };
    const next = parsePublicHttpUrl(new URL(location, current).toString());
    if (!next) throw new Error('redirected to a non-public address');
    current = next;
  }
  throw new Error('too many redirects');
}

async function handleScan(target, corsHeaders) {
  const pageUrl = parsePublicHttpUrl(target);
  if (!pageUrl) return json({ error: 'url must be a public http(s) address' }, 400, corsHeaders);

  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; FUSE-proxy)', Accept: 'text/html,*/*' };
  let pageRes, finalUrl;
  try {
    ({ res: pageRes, url: finalUrl } = await fetchPublic(pageUrl, { headers }));
  } catch (e) {
    return json({ error: 'could not fetch page: ' + (e.message || 'network error') }, 502, corsHeaders);
  }
  if (!pageRes.ok) return json({ error: 'page returned ' + pageRes.status }, 502, corsHeaders);
  const html = await readCapped(pageRes);

  const found = [...(html.match(ADDRESS_RE) || [])];

  // SPA mint sites ship the contract address inside their JS bundles, not the HTML.
  // Only follow scripts on the page's own site to keep this from being a general crawler.
  const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
    .map((m) => {
      try {
        return new URL(m[1], finalUrl);
      } catch (e) {
        return null;
      }
    })
    .filter((u) => u && u.hostname === finalUrl.hostname && parsePublicHttpUrl(u.toString()))
    .slice(0, MAX_SCRIPTS);

  const scripts = await Promise.allSettled(
    scriptSrcs.map(async (u) => {
      const { res: r } = await fetchPublic(u, { headers });
      return r.ok ? readCapped(r) : '';
    })
  );
  for (const s of scripts) {
    if (s.status === 'fulfilled') found.push(...(s.value.match(ADDRESS_RE) || []));
  }

  // Keep repeats — the page ranks candidates by frequency.
  return json({ url: finalUrl.toString(), addresses: found.slice(0, 2000) }, 200, corsHeaders);
}

// Chains Etherscan doesn't index: their Blockscout explorer answers the same getabi call, keyless.
const BLOCKSCOUT_APIS = {
  4663: 'https://robinhoodchain.blockscout.com/api', // Robinhood Chain (override: BLOCKSCOUT_API_4663)
};

// Etherscan chains whose Blockscout explorer also serves verified ABIs keyless — used when the
// worker has no ETHERSCAN_API_KEY, or Etherscan doesn't have the contract verified.
const BLOCKSCOUT_FALLBACK_APIS = {
  1: 'https://eth.blockscout.com/api',
  11155111: 'https://eth-sepolia.blockscout.com/api',
};

async function getAbiJson(url) {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  try {
    return await res.json();
  } catch (e) {
    return { status: '0', result: `explorer returned HTTP ${res.status}` };
  }
}

async function handleAbi(address, chainId, env, corsHeaders) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return json({ status: '0', result: 'invalid address' }, 400, corsHeaders);
  if (!/^\d+$/.test(chainId)) return json({ status: '0', result: 'invalid chainid' }, 400, corsHeaders);
  const blockscoutPath = `?module=contract&action=getabi&address=${address}`;
  const blockscout = env[`BLOCKSCOUT_API_${chainId}`] || BLOCKSCOUT_APIS[chainId];
  if (blockscout) return json(await getAbiJson(blockscout + blockscoutPath), 200, corsHeaders);

  let data = null;
  if (env.ETHERSCAN_API_KEY) {
    data = await getAbiJson(
      `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getabi` +
        `&address=${address}&apikey=${encodeURIComponent(env.ETHERSCAN_API_KEY)}`
    );
    if (data.status === '1') return json(data, 200, corsHeaders);
  }
  const fallback = BLOCKSCOUT_FALLBACK_APIS[chainId];
  if (fallback) {
    const viaBlockscout = await getAbiJson(fallback + blockscoutPath).catch(() => null);
    if (viaBlockscout && viaBlockscout.status === '1') return json(viaBlockscout, 200, corsHeaders);
  }
  if (data) return json(data, 200, corsHeaders);
  return json({ status: '0', result: fallback ? 'ABI not found — contract may be unverified' : 'ETHERSCAN_API_KEY secret is not set on this worker' }, 200, corsHeaders);
}

async function handleSlug(slug, env, corsHeaders) {
  if (!env.OPENSEA_API_KEY) {
    return json({ error: 'OPENSEA_API_KEY secret is not set on this worker' }, 500, corsHeaders);
  }
  const openseaRes = await fetchWithTimeout(
    `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`,
    { headers: { 'x-api-key': env.OPENSEA_API_KEY, Accept: 'application/json' } }
  );
  const body = await openseaRes.text();
  return new Response(body, {
    status: openseaRes.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ---------- POST ?rpc=<chain> : JSON-RPC relay ----------
// Public RPCs for newer chains often lack browser CORS headers or rate-limit hard. The relay
// fixes CORS and lets you point a chain at a private endpoint (Alchemy/QuickNode/…) by
// setting a secret like RPC_ROBINHOOD, without that URL (and its key) living in the browser.
const DEFAULT_RPCS = {
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
  ethereum: 'https://ethereum-rpc.publicnode.com',
};
const RPC_METHODS = new Set([
  'eth_chainId', 'net_version', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBalance',
  'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
  'eth_feeHistory', 'eth_getTransactionCount', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_sendRawTransaction', 'eth_getLogs',
]);
const MAX_RPC_BODY = 512 * 1024;

async function handleRpc(chain, request, env, corsHeaders) {
  const upstream = env[`RPC_${chain.toUpperCase()}`] || DEFAULT_RPCS[chain];
  if (!upstream) return json({ error: `no RPC configured for chain "${chain}"` }, 400, corsHeaders);
  const text = await request.text();
  if (text.length > MAX_RPC_BODY) return json({ error: 'request too large' }, 413, corsHeaders);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    return json({ error: 'invalid JSON' }, 400, corsHeaders);
  }
  const calls = Array.isArray(payload) ? payload : [payload];
  if (!calls.length || calls.length > 50) return json({ error: 'batch must have 1-50 calls' }, 400, corsHeaders);
  const blocked = calls.find((c) => !c || !RPC_METHODS.has(c.method));
  if (blocked) return json({ jsonrpc: '2.0', id: blocked && blocked.id, error: { code: -32601, message: `method not allowed through relay: ${blocked && blocked.method}` } }, 200, corsHeaders);
  const res = await fetchWithTimeout(upstream, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
  return new Response(await res.text(), { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ---------- ?collection= : everything FUSE shows about an OpenSea collection ----------

const OPENSEA_API = 'https://api.opensea.io/api/v2';
const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1f0df003000390027140000faa719';
// Chains to try when a collection URL uses a bare contract address instead of a slug.
const OPENSEA_CHAINS = [
  'ethereum', 'base', 'robinhood', 'arbitrum', 'optimism', 'matic', 'zora', 'ape_chain', 'abstract',
  'shape', 'unichain', 'berachain', 'sei', 'blast', 'b3', 'soneium', 'ronin', 'flow', 'monad', 'hyperevm',
];
const COLLECTION_TTL_MS = 20000;
const collectionCache = new Map(); // per isolate; keeps polling clients from burning the OpenSea quota

function osFetch(path, env) {
  return fetchWithTimeout(`${OPENSEA_API}${path}`, {
    headers: { 'x-api-key': env.OPENSEA_API_KEY, Accept: 'application/json' },
  });
}

async function osJson(path, env) {
  const res = await osFetch(path, env);
  if (!res.ok) return { ok: false, status: res.status, data: null };
  return { ok: true, status: res.status, data: await res.json() };
}

const firstOf = (obj, keys) => {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  return null;
};

// OpenSea returns prices in a few shapes; turn them into a plain number of whole tokens.
function toTokenAmount(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    const raw = firstOf(v, ['value', 'amount', 'quantity', 'price']);
    const decimals = firstOf(v, ['decimals']) ?? (v.currency && v.currency.decimals);
    if (raw == null) return null;
    return decimals != null ? Number(raw) / 10 ** Number(decimals) : toTokenAmount(raw);
  }
  const n = Number(v);
  if (!isFinite(n)) return null;
  return /^\d{13,}$/.test(String(v)) ? n / 1e18 : n; // long integer strings are wei
}

function toIso(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  const d = isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function toCount(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// The drops endpoint is newer and its shape varies; read it defensively.
function normalizeDrop(d) {
  if (!d || typeof d !== 'object') return null;
  const src = d.drop && typeof d.drop === 'object' ? d.drop : d;
  const maxSupply = toCount(firstOf(src, ['max_supply', 'maxSupply', 'max_total_supply', 'supply_cap', 'total_supply_cap'])) || null;
  // 0 minted is a real answer (a drop that just opened), not "unknown".
  const minted = toCount(firstOf(src, ['total_minted', 'minted', 'num_minted', 'minted_count', 'items_minted', 'total_supply']));
  const rawStages = firstOf(src, ['stages', 'mint_stages', 'drop_stages', 'phases']) || [];
  const stages = (Array.isArray(rawStages) ? rawStages : []).slice(0, 10).map((s) => {
    const priceRaw = firstOf(s, ['price', 'mint_price', 'unit_price', 'cost']);
    const currency = (priceRaw && typeof priceRaw === 'object' && (priceRaw.currency?.symbol || priceRaw.symbol)) || firstOf(s, ['currency', 'price_currency', 'payment_token']) || null;
    return {
      name: String(firstOf(s, ['name', 'label', 'title', 'stage_name', 'stage_type', 'type']) || 'Stage'),
      price: toTokenAmount(priceRaw),
      currency: typeof currency === 'string' ? currency : currency && currency.symbol ? currency.symbol : null,
      start: toIso(firstOf(s, ['start_time', 'start_date', 'startTime', 'starts_at', 'start'])),
      end: toIso(firstOf(s, ['end_time', 'end_date', 'endTime', 'ends_at', 'end'])),
      maxPerWallet: Number(firstOf(s, ['max_per_wallet', 'max_total_mintable_by_wallet', 'limit_per_wallet', 'per_wallet_limit', 'wallet_limit'])) || null,
      // Lets the page tell allowlist stages from public ones and match ?dropmint= answers to a stage.
      id: s.uuid != null ? String(s.uuid) : null,
      type: typeof s.stage_type === 'string' ? s.stage_type : null,
      allowlistCount: toCount(s.allowlist_wallet_count),
    };
  });
  if (!maxSupply && minted == null && !stages.length) return null;
  const active = src.active_stage && typeof src.active_stage === 'object' ? src.active_stage : null;
  return {
    maxSupply, minted, stages,
    isMinting: typeof src.is_minting === 'boolean' ? src.is_minting : null,
    activeStageId: active && active.uuid != null ? String(active.uuid) : null,
    dropType: typeof src.drop_type === 'string' ? src.drop_type : null,
  };
}

// ---------- ?dropmint=<slug>&minter=<0x…>&quantity=<n> ----------
// OpenSea builds the mint transaction for whichever stage is live now — including the
// allowlist proof or signature for GTD/FCFS stages, which a page can't produce itself — or
// says why this wallet can't mint (not on the allowlist, over its limit, sold out…). That makes
// it both FUSE's per-wallet eligibility check and the way it mints presale stages.
const DROP_MINT_CODES = new Set(['MINTER_NOT_ELIGIBLE', 'MINT_LIMIT_EXCEEDED', 'SUPPLY_EXHAUSTED', 'INSUFFICIENT_BALANCE', 'NO_PAYOUT_ADDRESS', 'NOT_MINTING', 'DROP_NOT_FOUND', 'UNSUPPORTED_DROP_TYPE']);

async function handleDropMint(slug, minter, quantity, env, corsHeaders) {
  if (!env.OPENSEA_API_KEY) return json({ error: 'OPENSEA_API_KEY secret is not set on this worker' }, 500, corsHeaders);
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(slug)) return json({ error: 'invalid collection slug' }, 400, corsHeaders);
  if (!/^0x[a-fA-F0-9]{40}$/.test(minter || '')) return json({ error: 'invalid minter address' }, 400, corsHeaders);
  const qty = Number(quantity || 1);
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) return json({ error: 'quantity must be 1-100' }, 400, corsHeaders);

  const res = await fetchWithTimeout(`${OPENSEA_API}/drops/${encodeURIComponent(slug)}/mint`, {
    method: 'POST',
    headers: { 'x-api-key': env.OPENSEA_API_KEY, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ minter, quantity: qty }),
  });
  let body = {};
  try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (res.ok && body.to && body.data) {
    return json({
      ok: true, to: body.to, data: body.data, value: String(body.value ?? '0'), chain: body.chain || null,
      stageId: body.stage_uuid != null ? String(body.stage_uuid) : null, stageType: body.stage_type || null,
      stageStart: toIso(body.stage_start_time), stageEnd: toIso(body.stage_end_time),
    }, 200, corsHeaders);
  }
  if (res.status === 401 || res.status === 403) return json({ error: 'OpenSea rejected the API key' }, 401, corsHeaders);
  const code = DROP_MINT_CODES.has(body.code) ? body.code : null;
  const message = (Array.isArray(body.errors) && body.errors.filter((e) => typeof e === 'string').join(' ')) || `OpenSea returned HTTP ${res.status}`;
  // 200 with ok:false — "this wallet can't mint right now" is an answer, not a worker failure.
  return json({ ok: false, status: res.status, code, message: message.slice(0, 300) }, 200, corsHeaders);
}

async function resolveCollection(id, env) {
  const direct = await osJson(`/collections/${encodeURIComponent(id)}`, env);
  if (direct.ok) return direct.data;
  if (direct.status === 401 || direct.status === 403) throw Object.assign(new Error('OpenSea rejected the API key'), { status: 401 });
  if (!/^0x[a-fA-F0-9]{40}$/.test(id)) return null;
  // Ask every chain at once (one by one was up to 20 round trips) and take the first hit in
  // OPENSEA_CHAINS order, so a contract on several chains still resolves the same way.
  const lookups = await Promise.allSettled(OPENSEA_CHAINS.map((chain) => osJson(`/chain/${chain}/contract/${id}`, env)));
  const hit = lookups.find((r) => r.status === 'fulfilled' && r.value.ok && r.value.data && r.value.data.collection);
  if (!hit) return null;
  const byContract = await osJson(`/collections/${encodeURIComponent(hit.value.data.collection)}`, env);
  return byContract.ok ? byContract.data : null;
}

async function handleCollection(id, env, corsHeaders) {
  if (!env.OPENSEA_API_KEY) return json({ error: 'OPENSEA_API_KEY secret is not set on this worker' }, 500, corsHeaders);
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(id)) return json({ error: 'invalid collection slug' }, 400, corsHeaders);

  const key = id.toLowerCase();
  const hit = collectionCache.get(key);
  if (hit && Date.now() - hit.at < COLLECTION_TTL_MS) return json(hit.body, 200, corsHeaders);

  let col;
  try {
    col = await resolveCollection(id, env);
  } catch (e) {
    return json({ error: e.message }, e.status || 502, corsHeaders);
  }
  if (!col) return json({ error: `No OpenSea collection found for "${id}"` }, 404, corsHeaders);

  const slug = col.collection || id;
  const [stats, nfts, drop] = await Promise.allSettled([
    osJson(`/collections/${encodeURIComponent(slug)}/stats`, env),
    osJson(`/collection/${encodeURIComponent(slug)}/nfts?limit=20`, env),
    osJson(`/drops/${encodeURIComponent(slug)}`, env),
  ]);
  const ok = (r) => (r.status === 'fulfilled' && r.value.ok ? r.value.data : null);
  const st = (ok(stats) || {}).total || {};
  const contract = (col.contracts || [])[0] || {};
  const creatorFeePct = (col.fees || [])
    .filter((f) => String(f.recipient || '').toLowerCase() !== OPENSEA_FEE_RECIPIENT)
    .reduce((sum, f) => sum + (Number(f.fee) || 0), 0);
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

  const body = {
    slug,
    name: col.name || slug,
    description: col.description || '',
    image: safeUrl(col.image_url),
    banner: safeUrl(col.banner_image_url),
    openseaUrl: safeUrl(col.opensea_url) || `https://opensea.io/collection/${slug}`,
    chain: contract.chain || null,
    contract: contract.address || null,
    creatorFeePct: Math.round(creatorFeePct * 100) / 100,
    supply: Number(col.total_supply) || null,
    stats: {
      floor: st.floor_price ?? null,
      floorSymbol: st.floor_price_symbol || null,
      owners: st.num_owners ?? null,
      volume: st.volume ?? null,
      sales: st.sales ?? null,
    },
    items: ((ok(nfts) || {}).nfts || [])
      .map((n) => ({ id: n.identifier, name: n.name || `#${n.identifier}`, image: safeUrl(n.display_image_url || n.image_url) }))
      .filter((n) => n.image),
    drop: normalizeDrop(ok(drop)),
    fetchedAt: new Date().toISOString(),
  };
  collectionCache.set(key, { at: Date.now(), body });
  if (collectionCache.size > 200) collectionCache.delete(collectionCache.keys().next().value);
  return json(body, 200, corsHeaders);
}

export default {
  async fetch(request, env) {
    const { headers: corsHeaders, originAllowed } = corsHeadersFor(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: originAllowed ? 204 : 403, headers: corsHeaders });
    }
    if (!originAllowed) return json({ error: 'origin not allowed' }, 403, corsHeaders);

    const params = new URL(request.url).searchParams;
    if (request.method === 'POST' && /^[a-z_]{2,30}$/.test(params.get('rpc') || '')) {
      try {
        return await handleRpc(params.get('rpc'), request, env, corsHeaders);
      } catch (e) {
        return json({ error: 'RPC relay failed: ' + (e.message || 'unknown error') }, 502, corsHeaders);
      }
    }
    if (request.method !== 'GET') return json({ error: 'GET only (POST for ?rpc=)' }, 405, corsHeaders);

    // The Origin check only stops browsers — scripts can send any Origin header. The LIMITER
    // binding (wrangler.toml) caps how much anyone can pull through your OpenSea/Etherscan keys.
    // The RPC relay above is left out so a big mint run never gets throttled mid-fire.
    if (env.LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'rate limited — slow down and try again in a minute' }, 429, corsHeaders);
    }

    try {
      if (params.get('dropmint')) return await handleDropMint(params.get('dropmint'), params.get('minter'), params.get('quantity'), env, corsHeaders);
      if (params.get('collection')) return await handleCollection(params.get('collection'), env, corsHeaders);
      if (params.get('slug')) return await handleSlug(params.get('slug'), env, corsHeaders);
      if (params.get('abi')) return await handleAbi(params.get('abi'), params.get('chainid') || '1', env, corsHeaders);
      if (params.get('url')) return await handleScan(params.get('url'), corsHeaders);
    } catch (e) {
      return json({ error: 'upstream request failed: ' + (e.message || 'unknown error') }, 502, corsHeaders);
    }
    return json({ error: 'use ?collection=, ?slug=, ?abi=&chainid=, ?dropmint=&minter=, or ?url=' }, 400, corsHeaders);
  },
};
