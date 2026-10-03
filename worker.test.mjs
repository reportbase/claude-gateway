/* Runs the Worker handler directly against a stubbed upstream — no wrangler,
   no network. Node 22 already provides Request/Response/ReadableStream, which
   are the same web APIs the Workers runtime exposes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, originAllowed, memoryLimit, _resetMemoryLimit } from '../src/worker.js';

const ORIGIN = 'https://chess.example.com';
const baseEnv = () => ({
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  ALLOWED_ORIGINS: ORIGIN + ',https://*.tangent.dev,null',
  RATE_LIMIT_PER_MIN: '0',
  ALLOWED_MODELS: '',
  MAX_TOKENS_CAP: '0',
  MAX_BODY_BYTES: '262144',
});

/* Capture what the Worker sends upstream, and reply with whatever the test
   wants. Returns a restore function. */
function stubUpstream(reply){
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, headers: new Headers(init.headers) });
    return typeof reply === 'function' ? reply(url, init)
      : new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const post = (body, headers = {}, path = '/v1/messages') =>
  new Request('https://gw.workers.dev' + path, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('origin matching: exact, wildcard, null, and the look-alike guard', () => {
  const rules = ['https://chess.example.com', 'https://*.example.com', 'null'];
  assert.equal(originAllowed('https://chess.example.com', rules), true);
  assert.equal(originAllowed('https://sub.example.com', rules), true);
  assert.equal(originAllowed('null', rules), true, 'file:// pages send Origin: null');
  assert.equal(originAllowed('https://evil-example.com', rules), false, 'must not match *.example.com');
  assert.equal(originAllowed('http://chess.example.com', rules), false, 'scheme is part of the origin');
  assert.equal(originAllowed('https://example.com', rules), false, 'apex is not a subdomain');
  assert.equal(originAllowed(null, rules), false);
  assert.equal(originAllowed('https://anything.com', ['*']), true);
  assert.equal(originAllowed('https://anything.com', []), false, 'empty config denies');
});

test('preflight: allowed origin gets CORS, disallowed gets a bare 403', async () => {
  const req = o => new Request('https://gw.workers.dev/v1/messages', { method: 'OPTIONS', headers: { origin: o } });
  const ok = await handleRequest(req(ORIGIN), baseEnv());
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(ok.headers.get('vary'), 'Origin');
  assert.match(ok.headers.get('access-control-allow-headers'), /anthropic-version/);

  const no = await handleRequest(req('https://evil.com'), baseEnv());
  assert.equal(no.status, 403);
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});

test('the API key is injected upstream and never accepted from the client', async () => {
  const up = stubUpstream();
  try {
    const res = await handleRequest(
      post({ model: 'claude-haiku-4-5', max_tokens: 10, messages: [] },
           { 'x-api-key': 'sk-ant-ATTACKER', authorization: 'Bearer nope' }),
      baseEnv());
    assert.equal(res.status, 200);
    assert.equal(up.calls.length, 1);
    assert.equal(up.calls[0].headers.get('x-api-key'), 'sk-ant-secret');
    assert.equal(up.calls[0].headers.get('authorization'), null, 'client authorization must be dropped');
    assert.equal(up.calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(up.calls[0].headers.get('anthropic-version'), '2023-06-01', 'defaulted when omitted');
  } finally { up.restore(); }
});

test('a disallowed origin never reaches upstream', async () => {
  const up = stubUpstream();
  try {
    const res = await handleRequest(post({ messages: [] }, { origin: 'https://evil.com' }), baseEnv());
    assert.equal(res.status, 403);
    assert.equal(up.calls.length, 0, 'must short-circuit before spending a request');
    const j = await res.json();
    assert.equal(j.error.type, 'forbidden');
  } finally { up.restore(); }
});

test('a request with no Origin is refused unless ALLOW_NO_ORIGIN is set', async () => {
  const up = stubUpstream();
  try {
    const bare = () => new Request('https://gw.workers.dev/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"messages":[]}' });
    assert.equal((await handleRequest(bare(), baseEnv())).status, 403);
    const res = await handleRequest(bare(), { ...baseEnv(), ALLOW_NO_ORIGIN: 'true' });
    assert.equal(res.status, 200);
  } finally { up.restore(); }
});

test('model allowlist rejects, max_tokens cap clamps', async () => {
  const up = stubUpstream();
  try {
    const env = { ...baseEnv(), ALLOWED_MODELS: 'claude-haiku-4-5', MAX_TOKENS_CAP: '100' };
    const bad = await handleRequest(post({ model: 'claude-opus-4', max_tokens: 10, messages: [] }), env);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error.message, /not allowed/);
    assert.equal(up.calls.length, 0);

    const ok = await handleRequest(post({ model: 'claude-haiku-4-5', max_tokens: 99999, messages: [] }), env);
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(up.calls[0].init.body).max_tokens, 100, 'clamped, not rejected');
  } finally { up.restore(); }
});

test('oversized bodies, bad JSON, unknown paths and bad methods are refused', async () => {
  const up = stubUpstream();
  try {
    const big = await handleRequest(
      post({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(5000) }] }),
      { ...baseEnv(), MAX_BODY_BYTES: '100' });
    assert.equal(big.status, 413);

    const junk = new Request('https://gw.workers.dev/v1/messages', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: 'not json' });
    assert.equal((await handleRequest(junk, baseEnv())).status, 400);

    const nope = await handleRequest(post({ messages: [] }, {}, '/v1/complete'), baseEnv());
    assert.equal(nope.status, 404);

    const del = new Request('https://gw.workers.dev/v1/messages', { method: 'DELETE', headers: { origin: ORIGIN } });
    assert.equal((await handleRequest(del, baseEnv())).status, 405);
    assert.equal(up.calls.length, 0);
  } finally { up.restore(); }
});

test('a missing secret fails loudly instead of calling upstream', async () => {
  const up = stubUpstream();
  try {
    const env = { ...baseEnv() }; delete env.ANTHROPIC_API_KEY;
    const res = await handleRequest(post({ messages: [] }), env);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error.message, /wrangler secret put/);
    assert.equal(up.calls.length, 0);
  } finally { up.restore(); }
});

test('rate limit returns 429 with retry-after once the window is spent', async () => {
  _resetMemoryLimit();
  const up = stubUpstream();
  try {
    const env = { ...baseEnv(), RATE_LIMIT_PER_MIN: '3' };
    const mk = () => new Request('https://gw.workers.dev/v1/messages', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9' },
      body: '{"model":"m","messages":[]}' });
    for (let i = 0; i < 3; i++) assert.equal((await handleRequest(mk(), env)).status, 200, 'call ' + (i + 1));
    const blocked = await handleRequest(mk(), env);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal(blocked.headers.get('access-control-allow-origin'), ORIGIN, '429 still needs CORS to be readable');
    assert.equal(up.calls.length, 3, 'the blocked call never reached upstream');
  } finally { up.restore(); }
});

test('rate limit buckets are per IP', async () => {
  _resetMemoryLimit();
  const up = stubUpstream();
  try {
    const env = { ...baseEnv(), RATE_LIMIT_PER_MIN: '1' };
    const mk = ip => new Request('https://gw.workers.dev/v1/messages', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: '{"model":"m","messages":[]}' });
    assert.equal((await handleRequest(mk('1.1.1.1'), env)).status, 200);
    assert.equal((await handleRequest(mk('1.1.1.1'), env)).status, 429);
    assert.equal((await handleRequest(mk('2.2.2.2'), env)).status, 200, 'a different IP has its own budget');
  } finally { up.restore(); }
});

test('memoryLimit rolls over when the window expires', () => {
  _resetMemoryLimit();
  const t0 = 1_000_000;
  assert.equal(memoryLimit('k', 2, 60000, t0).ok, true);
  assert.equal(memoryLimit('k', 2, 60000, t0 + 1).ok, true);
  assert.equal(memoryLimit('k', 2, 60000, t0 + 2).ok, false);
  assert.equal(memoryLimit('k', 2, 60000, t0 + 60001).ok, true, 'new window, fresh budget');
});

test('SSE is streamed through, not buffered', async () => {
  let pushed = 0;
  const body = new ReadableStream({
    async start(c){
      const enc = new TextEncoder();
      c.enqueue(enc.encode('event: x\ndata: {"type":"a"}\n\n')); pushed++;
      await new Promise(r => setTimeout(r, 60));
      c.enqueue(enc.encode('data: {"type":"b"}\n\n')); pushed++;
      c.close();
    },
  });
  const up = stubUpstream(() => new Response(body, {
    status: 200, headers: { 'content-type': 'text/event-stream' } }));
  try {
    const res = await handleRequest(post({ model: 'm', messages: [], stream: true }), baseEnv());
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform');
    // The first chunk must be readable while the upstream is still producing.
    const rd = res.body.getReader();
    const first = await rd.read();
    assert.ok(new TextDecoder().decode(first.value).includes('"a"'));
    assert.equal(pushed, 1, 'handler returned before the stream finished — genuinely streaming');
    let rest = '';
    for (;;){ const { done, value } = await rd.read(); if (done) break; rest += new TextDecoder().decode(value); }
    assert.match(rest, /"b"/);
  } finally { up.restore(); }
});

test('upstream errors pass through with status and CORS intact', async () => {
  const up = stubUpstream(() => new Response(
    JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } }),
    { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_123' } }));
  try {
    const res = await handleRequest(post({ model: 'm', messages: [] }), baseEnv());
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(res.headers.get('request-id'), 'req_123', 'exposed for support tickets');
    assert.equal((await res.json()).error.message, 'bad model');
  } finally { up.restore(); }
});

test('an unreachable upstream becomes a 502, not a crash', async () => {
  const up = stubUpstream(() => { throw new Error('connect ECONNREFUSED'); });
  try {
    const res = await handleRequest(post({ model: 'm', messages: [] }), baseEnv());
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /Could not reach/);
  } finally { up.restore(); }
});

test('health reports configuration without leaking the key', async () => {
  const res = await handleRequest(
    new Request('https://gw.workers.dev/health', { headers: { origin: ORIGIN } }), baseEnv());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.keyConfigured, true);
  assert.equal(j.allowedOrigins, 3);
  assert.ok(!JSON.stringify(j).includes('sk-ant-secret'), 'the key must never appear in a response');
});
