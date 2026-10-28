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
 *      wrangler secret put ETHERSCAN_API_KEY      (optional — enables ?abi=)
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' });
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

async function handleScan(target, corsHeaders) {
  const pageUrl = parsePublicHttpUrl(target);
  if (!pageUrl) return json({ error: 'url must be a public http(s) address' }, 400, corsHeaders);

  const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; FUSE-proxy)', Accept: 'text/html,*/*' };
  let pageRes;
  try {
    pageRes = await fetchWithTimeout(pageUrl.toString(), { headers });
  } catch (e) {
    return json({ error: 'could not fetch page: ' + (e.message || 'network error') }, 502, corsHeaders);
  }
  if (!pageRes.ok) return json({ error: 'page returned ' + pageRes.status }, 502, corsHeaders);
  const html = await readCapped(pageRes);

  const found = [...(html.match(ADDRESS_RE) || [])];

  // SPA mint sites ship the contract address inside their JS bundles, not the HTML.
  // Only follow scripts on the page's own site to keep this from being a general crawler.
  const finalUrl = new URL(pageRes.url || pageUrl.toString());
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
      const r = await fetchWithTimeout(u.toString(), { headers });
      return r.ok ? readCapped(r) : '';
    })
  );
  for (const s of scripts) {
    if (s.status === 'fulfilled') found.push(...(s.value.match(ADDRESS_RE) || []));
  }

  // Keep repeats — the page ranks candidates by frequency.
  return json({ url: finalUrl.toString(), addresses: found.slice(0, 2000) }, 200, corsHeaders);
}

async function handleAbi(address, chainId, env, corsHeaders) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return json({ status: '0', result: 'invalid address' }, 400, corsHeaders);
  if (!/^\d+$/.test(chainId)) return json({ status: '0', result: 'invalid chainid' }, 400, corsHeaders);
  if (!env.ETHERSCAN_API_KEY) {
    return json({ status: '0', result: 'ETHERSCAN_API_KEY secret is not set on this worker' }, 500, corsHeaders);
  }
  const url =
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getabi` +
    `&address=${address}&apikey=${encodeURIComponent(env.ETHERSCAN_API_KEY)}`;
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  const body = await res.text();
  return new Response(body, { status: res.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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

// The drops endpoint is newer and its shape varies; read it defensively.
function normalizeDrop(d) {
  if (!d || typeof d !== 'object') return null;
  const src = d.drop && typeof d.drop === 'object' ? d.drop : d;
  const maxSupply = Number(firstOf(src, ['max_supply', 'maxSupply', 'max_total_supply', 'supply_cap', 'total_supply_cap'])) || null;
  const minted = Number(firstOf(src, ['total_minted', 'minted', 'num_minted', 'minted_count', 'items_minted', 'total_supply'])) || null;
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
    };
  });
  if (!maxSupply && !minted && !stages.length) return null;
  return { maxSupply, minted, stages };
}

async function resolveCollection(id, env) {
  const direct = await osJson(`/collections/${encodeURIComponent(id)}`, env);
  if (direct.ok) return direct.data;
  if (direct.status === 401 || direct.status === 403) throw Object.assign(new Error('OpenSea rejected the API key'), { status: 401 });
  if (!/^0x[a-fA-F0-9]{40}$/.test(id)) return null;
  for (const chain of OPENSEA_CHAINS) {
    const c = await osJson(`/chain/${chain}/contract/${id}`, env);
    if (c.ok && c.data && c.data.collection) {
      const byContract = await osJson(`/collections/${encodeURIComponent(c.data.collection)}`, env);
      if (byContract.ok) return byContract.data;
    }
  }
  return null;
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
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405, corsHeaders);

    const params = new URL(request.url).searchParams;
    try {
      if (params.get('collection')) return await handleCollection(params.get('collection'), env, corsHeaders);
      if (params.get('slug')) return await handleSlug(params.get('slug'), env, corsHeaders);
      if (params.get('abi')) return await handleAbi(params.get('abi'), params.get('chainid') || '1', env, corsHeaders);
      if (params.get('url')) return await handleScan(params.get('url'), corsHeaders);
    } catch (e) {
      return json({ error: 'upstream request failed: ' + (e.message || 'unknown error') }, 502, corsHeaders);
    }
    return json({ error: 'use ?collection=, ?slug=, ?abi=&chainid=, or ?url=' }, 400, corsHeaders);
  },
};
