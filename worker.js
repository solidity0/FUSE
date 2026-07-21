/**
 * FUSE OpenSea Proxy — Cloudflare Worker
 *
 * Why this exists: OpenSea's own docs say their API key must never be used
 * client-side (browser JS), and their API doesn't reliably send CORS headers
 * for arbitrary browser origins either way. A pure client-side tool like FUSE
 * can't call OpenSea directly — this tiny proxy holds the key server-side and
 * just relays the one request FUSE needs (collection lookup by slug), adding
 * proper CORS headers so the browser is allowed to read the response.
 *
 * SETUP (about 2 minutes):
 * 1. Go to https://dash.cloudflare.com -> Workers & Pages -> Create -> Worker.
 * 2. Paste this whole file in as the Worker's code, replacing the default.
 * 3. Set a secret so your OpenSea API key is never visible in the source:
 *      wrangler secret put OPENSEA_API_KEY
 *    (or, in the dashboard: Settings -> Variables -> add OPENSEA_API_KEY as
 *    an encrypted secret, not a plain text variable)
 * 4. Deploy. Copy the worker's URL (looks like
 *    https://fuse-opensea-proxy.<your-subdomain>.workers.dev).
 * 5. Paste that URL into FUSE's Settings -> "OpenSea proxy URL" field.
 *    You no longer need to put an OpenSea API key directly into FUSE itself.
 */

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const slug = url.searchParams.get('slug');

    if (!slug) {
      return new Response(JSON.stringify({ error: 'missing ?slug= parameter' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!env.OPENSEA_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'OPENSEA_API_KEY secret is not set on this worker' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const openseaRes = await fetch(
      `https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`,
      { headers: { 'x-api-key': env.OPENSEA_API_KEY, Accept: 'application/json' } }
    );

    const body = await openseaRes.text();
    return new Response(body, {
      status: openseaRes.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  },
};
