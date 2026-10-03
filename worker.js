/* claude-gateway — a reusable Cloudflare Worker in front of the Anthropic API.
   ---------------------------------------------------------------------------
   Why this exists: browser apps that call api.anthropic.com directly have to
   ship an API key to the client and set the dangerous-direct-browser-access
   header. This Worker holds the key as a secret, so the browser never sees it,
   and every app you write points at the same URL instead.

   What it does, in order, for every request:
     1. CORS preflight, answered without touching upstream.
     2. Origin allowlist        — who is allowed to ask.
     3. Rate limit              — how often they may ask.
     4. Path allowlist          — what they may call.
     5. Body policy             — model allowlist, max_tokens cap, size cap.
     6. Proxy to Anthropic with the real key injected, streaming untouched.

   Design notes worth keeping:
   - The response body is passed through as a stream. SSE from Anthropic must
     arrive token-by-token, so nothing here may await the whole body.
   - Client-supplied credentials are stripped, never forwarded. A caller cannot
     smuggle their own key (or someone else's) through this Worker.
   - Origin checks stop OTHER WEBSITES from using your quota in a browser. They
     do NOT stop curl, which can send any Origin it likes. The rate limit is the
     real backstop. See README §Security for the honest threat model.
   - Everything is config, not code: adding an app means editing ALLOWED_ORIGINS
     in wrangler.toml, not touching this file. */

const UPSTREAM = 'https://api.anthropic.com';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/* Paths a client may reach. Anything else is 404 — this is a Claude gateway,
   not an open proxy. count_tokens and models are read-only and cheap; they are
   here because apps that budget context or populate a model picker need them. */
const DEFAULT_PATHS = '/v1/messages,/v1/messages/count_tokens,/v1/models';

/* Headers we forward upstream. An allowlist, not a blocklist: a blocklist grows
   a hole every time the platform adds a header. Note the absence of x-api-key
   and authorization — those are ours to set, never the caller's. */
const FORWARD_HEADERS = [
  'content-type',
  'anthropic-version',
  'anthropic-beta',
  'accept',
];

/* Upstream headers worth letting browser JS read (CORS hides the rest). The
   rate-limit family is what a client needs to back off intelligently. */
const EXPOSE_HEADERS = [
  'request-id',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
  'retry-after',
  'x-gateway-limit-remaining',
].join(', ');

const csv = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const num = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };

/* ── Origin matching ──────────────────────────────────────────────────────
   Supported forms in ALLOWED_ORIGINS:
     https://chess.example.com   exact match
     https://*.example.com       any subdomain (NOT the bare apex — list it too)
     null                        pages opened from file:// send Origin: null
     *                           everything (development only)
   Matching is exact-string on scheme+host+port; no normalisation games, because
   an origin that only ALMOST matches should fail loudly, not silently pass. */
export function originAllowed(origin, allowed){
  if (!allowed.length) return false;
  if (allowed.includes('*')) return true;
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  for (const rule of allowed){
    if (!rule.startsWith('http') || !rule.includes('://*.')) continue;
    const [scheme, rest] = rule.split('://');
    const suffix = rest.slice(1);                     // '*.example.com' → '.example.com'
    if (origin.startsWith(scheme + '://') && origin.endsWith(suffix)){
      // Guard against 'https://evil-example.com' matching '*.example.com':
      // the character before the suffix must be part of the hostname label.
      const host = origin.slice(scheme.length + 3);
      if (host.length > suffix.length) return true;
    }
  }
  return false;
}

/* ── Rate limiting ────────────────────────────────────────────────────────
   Two implementations, chosen at runtime:

   (a) env.RATE_LIMITER — Cloudflare's native rate-limiting binding. Accurate
       across the whole edge, free, no Durable Object needed. Preferred.
   (b) An in-isolate sliding window. Best-effort only: each Worker isolate keeps
       its own counter, so the true global limit is (isolates × limit). It is a
       speed bump, not a wall — but a speed bump costs nothing and covers you
       while the binding is being set up.
   Both key on client IP + origin, so one noisy app or IP cannot starve another. */
const _mem = new Map();
export function memoryLimit(key, limit, windowMs, now = Date.now()){
  let e = _mem.get(key);
  if (!e || now >= e.resetAt){ e = { count: 0, resetAt: now + windowMs }; _mem.set(key, e); }
  e.count++;
  if (_mem.size > 5000){                              // opportunistic sweep, no timers on Workers
    for (const [k, v] of _mem) if (now >= v.resetAt) _mem.delete(k);
  }
  return { ok: e.count <= limit, remaining: Math.max(0, limit - e.count),
           retryAfter: Math.max(1, Math.ceil((e.resetAt - now) / 1000)) };
}
export function _resetMemoryLimit(){ _mem.clear(); }   // tests only

async function checkRate(request, env, origin){
  const limit = num(env.RATE_LIMIT_PER_MIN, 60);
  if (limit <= 0) return { ok: true, remaining: -1 };  // 0 or negative disables the check
  const ip = request.headers.get('cf-connecting-ip') || 'no-ip';
  const key = ip + '|' + (origin || 'no-origin');
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function'){
    const { success } = await env.RATE_LIMITER.limit({ key });
    return { ok: !!success, remaining: -1, retryAfter: 60 };
  }
  return memoryLimit(key, limit, 60000);
}

/* ── CORS ─────────────────────────────────────────────────────────────────
   The allowed origin is echoed back specifically rather than '*': it keeps the
   response honest about who it was for, and it is the only form that still
   works if you ever add credentials. Vary: Origin keeps caches from serving
   one app's CORS headers to another. */
function corsHeaders(origin){
  const h = {
    'access-control-allow-origin': origin || 'null',
    'vary': 'Origin',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type, anthropic-version, anthropic-beta, accept',
    'access-control-max-age': '86400',
    'access-control-expose-headers': EXPOSE_HEADERS,
  };
  return h;
}

function json(status, obj, origin, extra){
  return new Response(JSON.stringify(obj), { status,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin), ...(extra || {}) } });
}

/* Error shape mirrors Anthropic's, so a client's existing error handling
   (`j.error.message`) works whether the failure came from here or from them. */
function fail(status, type, message, origin, extra){
  return json(status, { type: 'error', error: { type, message } }, origin, extra);
}

export async function handleRequest(request, env, ctx){
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const allowed = csv(env.ALLOWED_ORIGINS);

  /* 1 — Preflight. Answered even for disallowed origins (without CORS headers),
         so the browser reports a clean CORS failure instead of a network error. */
  if (request.method === 'OPTIONS'){
    if (!originAllowed(origin, allowed)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  /* Health check: safe to expose, tells you whether a deploy actually took the
     config you think it did. Never echoes the key — only whether one is set. */
  if (url.pathname === '/health' || url.pathname === '/'){
    return json(200, {
      ok: true,
      service: 'claude-gateway',
      keyConfigured: !!env.ANTHROPIC_API_KEY,
      allowedOrigins: allowed.length,
      allowedModels: csv(env.ALLOWED_MODELS),
      paths: csv(env.ALLOWED_PATHS || DEFAULT_PATHS),
      rateLimitPerMin: num(env.RATE_LIMIT_PER_MIN, 60),
      rateLimiter: env.RATE_LIMITER ? 'binding' : 'in-isolate',
      maxTokensCap: num(env.MAX_TOKENS_CAP, 0) || null,
    }, originAllowed(origin, allowed) ? origin : null);
  }

  /* 2 — Origin allowlist. A request with no Origin at all is a non-browser
         caller (curl, a server, a native app). Those are rejected unless the
         config opts in, because the default posture should be the safe one. */
  if (!originAllowed(origin, allowed)){
    const noOriginOk = String(env.ALLOW_NO_ORIGIN || '') === 'true' && !origin;
    if (!noOriginOk){
      return fail(403, 'forbidden',
        origin ? 'Origin ' + origin + ' is not allowed by this gateway.'
               : 'This gateway requires a browser Origin. Set ALLOW_NO_ORIGIN=true to permit direct calls.',
        null);
    }
  }

  if (!env.ANTHROPIC_API_KEY){
    return fail(500, 'configuration_error',
      'ANTHROPIC_API_KEY is not set on this Worker. Run: wrangler secret put ANTHROPIC_API_KEY', origin);
  }

  /* 3 — Rate limit. */
  const rl = await checkRate(request, env, origin);
  if (!rl.ok){
    return fail(429, 'rate_limit_error', 'Too many requests to this gateway — slow down.', origin,
      { 'retry-after': String(rl.retryAfter || 60) });
  }

  /* 4 — Path allowlist. */
  const paths = csv(env.ALLOWED_PATHS || DEFAULT_PATHS);
  if (!paths.includes(url.pathname)){
    return fail(404, 'not_found', 'No route for ' + url.pathname + ' on this gateway.', origin);
  }
  if (request.method !== 'POST' && request.method !== 'GET'){
    return fail(405, 'method_not_allowed', request.method + ' is not supported here.', origin);
  }

  /* 5 — Body policy. Only POSTs carry one; GET (/v1/models) skips straight
         through. We buffer the body deliberately — it is small, and it is the
         only way to enforce a model allowlist and a token cap. */
  let bodyText = null;
  if (request.method === 'POST'){
    const maxBytes = num(env.MAX_BODY_BYTES, 256 * 1024);
    bodyText = await request.text();
    if (bodyText.length > maxBytes){
      return fail(413, 'request_too_large',
        'Request body exceeds the gateway limit of ' + maxBytes + ' bytes.', origin);
    }
    let body;
    try { body = JSON.parse(bodyText); }
    catch { return fail(400, 'invalid_request_error', 'Request body is not valid JSON.', origin); }

    const models = csv(env.ALLOWED_MODELS);
    if (models.length && body.model && !models.includes(body.model)){
      return fail(400, 'invalid_request_error',
        'Model ' + body.model + ' is not allowed by this gateway. Allowed: ' + models.join(', '), origin);
    }
    const cap = num(env.MAX_TOKENS_CAP, 0);
    if (cap > 0 && num(body.max_tokens, 0) > cap){
      body.max_tokens = cap;                          // clamp rather than reject: the caller still gets an answer
      bodyText = JSON.stringify(body);
    }
  }

  /* 6 — Proxy. Headers are rebuilt from scratch: allowlisted client headers,
         then ours. The key goes on last so nothing can overwrite it. */
  const headers = new Headers();
  for (const name of FORWARD_HEADERS){
    const v = request.headers.get(name);
    if (v) headers.set(name, v);
  }
  if (!headers.has('anthropic-version')) headers.set('anthropic-version', DEFAULT_ANTHROPIC_VERSION);
  if (request.method === 'POST' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  headers.set('x-api-key', env.ANTHROPIC_API_KEY);

  let upstream;
  try {
    upstream = await fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method,
      headers,
      body: bodyText,
      // Anthropic streams SSE; buffering here would defeat the whole point.
      signal: request.signal,
    });
  } catch (e){
    return fail(502, 'upstream_error',
      'Could not reach the Anthropic API: ' + String((e && e.message) || e), origin);
  }

  /* Stream the body straight through. Do NOT await upstream.text() — that
     would turn a token-by-token stream into one late lump. */
  const out = new Headers(corsHeaders(origin));
  const ct = upstream.headers.get('content-type');
  if (ct) out.set('content-type', ct);
  for (const name of EXPOSE_HEADERS.split(', ')){
    const v = upstream.headers.get(name);
    if (v) out.set(name, v);
  }
  if (rl.remaining >= 0) out.set('x-gateway-limit-remaining', String(rl.remaining));
  // SSE through any intermediary: no transform, no buffering.
  if (ct && ct.includes('text/event-stream')){
    out.set('cache-control', 'no-cache, no-transform');
    out.set('x-accel-buffering', 'no');
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export default { fetch: handleRequest };
