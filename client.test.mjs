/* The client is tested against the REAL Worker handler wherever possible, so
   these are end-to-end through the gateway rather than against a hand-waved
   mock of it. Only api.anthropic.com itself is stubbed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeClient, ClaudeGatewayError } from '../client/claude-client.js';
import { handleRequest, _resetMemoryLimit } from '../src/worker.js';

const ORIGIN = 'https://chess.example.com';
const ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  ALLOWED_ORIGINS: ORIGIN,
  RATE_LIMIT_PER_MIN: '0',
  MAX_TOKENS_CAP: '0',
};

/* A fetch that routes gateway URLs into the Worker (adding the Origin a real
   browser would send) and everything else into the supplied upstream stub. */
function wiredFetch(upstream, env = ENV){
  const seen = { upstream: [] };
  const f = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://gw.test')){
      const headers = new Headers(init.headers || {});
      headers.set('origin', ORIGIN);
      return handleRequest(new Request(u, { ...init, headers }), env);
    }
    seen.upstream.push({ url: u, init, headers: new Headers(init.headers) });
    return upstream(u, init);
  };
  return { f, seen };
}

function withUpstream(stub, fn, env){
  const { f, seen } = wiredFetch(stub, env);
  const real = globalThis.fetch;
  globalThis.fetch = f;                       // the Worker's own fetch() to Anthropic
  return Promise.resolve(fn(f, seen)).finally(() => { globalThis.fetch = real; });
}

const sse = lines => new Response(lines.join('\n'), {
  status: 200, headers: { 'content-type': 'text/event-stream' } });

const DELTAS = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}', '',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Solid position"}}', '',
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" — knight is strong."}}', '',
  'data: {"type":"message_stop"}', '',
];

test('messages() round-trips through the gateway without a key in the client', async () => {
  await withUpstream(
    () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }),
    async (f, seen) => {
      const c = new ClaudeClient({ baseUrl: 'https://gw.test', model: 'claude-haiku-4-5', fetchImpl: f });
      const j = await c.messages({ max_tokens: 64, messages: [{ role: 'user', content: 'yo' }] });
      assert.equal(j.content[0].text, 'hi');
      // The browser leg carries no credential; the upstream leg carries the real one.
      assert.equal(seen.upstream[0].headers.get('x-api-key'), 'sk-ant-secret');
      const sent = JSON.parse(seen.upstream[0].init.body);
      assert.equal(sent.model, 'claude-haiku-4-5', 'default model applied');
      assert.equal(sent.max_tokens, 64);
    });
});

test('stream() concatenates text deltas and reports events', async () => {
  await withUpstream(() => sse(DELTAS), async f => {
    const c = new ClaudeClient({ baseUrl: 'https://gw.test', model: 'm', fetchImpl: f });
    const chunks = [], types = [];
    const full = await c.stream({ messages: [] },
      { onText: t => chunks.push(t), onEvent: e => types.push(e.type) });
    assert.equal(full, 'Solid position — knight is strong.');
    assert.equal(chunks.length, 2, 'delivered incrementally, not in one lump');
    assert.ok(types.includes('message_start') && types.includes('message_stop'));
  });
});

test('stream() sets stream:true on the request', async () => {
  await withUpstream(() => sse(DELTAS), async (f, seen) => {
    const c = new ClaudeClient({ baseUrl: 'https://gw.test', model: 'm', fetchImpl: f });
    await c.stream({ messages: [] });
    assert.equal(JSON.parse(seen.upstream[0].init.body).stream, true);
  });
});

test('a clone-hostile host retries once without the signal, then stops trying', async () => {
  await withUpstream(() => sse(DELTAS), async (inner) => {
    let sawSignal = 0, attempts = 0;
    const hostile = async (url, init = {}) => {
      attempts++;
      if (init.signal){ sawSignal++; throw new Error('DataCloneError: could not be cloned'); }
      return inner(url, init);
    };
    const c = new ClaudeClient({ baseUrl: 'https://gw.test', model: 'm', fetchImpl: hostile });
    const ac = new AbortController();
    assert.equal(await c.stream({ messages: [] }, { signal: ac.signal }), 'Solid position — knight is strong.');
    assert.equal(sawSignal, 1);
    assert.equal(attempts, 2, 'one failure, one retry');
    assert.equal(c.noSignal, true);
    await c.stream({ messages: [] }, { signal: ac.signal });
    assert.equal(sawSignal, 1, 'the second call never offers a signal again');
  });
});

test('stream() copes with a host that returns no readable stream', async () => {
  // Buffered SSE transcript…
  await withUpstream(() => sse(DELTAS), async inner => {
    const flatten = async (url, init) => {
      const r = await inner(url, init);
      return { ok: r.ok, status: r.status, body: null, text: () => r.text(), json: () => r.json() };
    };
    const c = new ClaudeClient({ baseUrl: 'https://gw.test', model: 'm', fetchImpl: flatten });
    assert.equal(await c.stream({ messages: [] }), 'Solid position — knight is strong.');
  });
  // …and a proxy that unwrapped the stream into plain message JSON.
  await withUpstream(
    () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'whole reply' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }),
    async inner => {
      const flatten = async (url, init) => {
        const r = await inner(url, init);
        return { ok: r.ok, status: r.status, body: null, text: () => r.text(), json: () => r.json() };
      };
      const c = new ClaudeClient({ baseUrl: 'https://gw.test', model: 'm', fetchImpl: flatten });
      assert.equal(await c.stream({ messages: [] }), 'whole reply');
    });
});

test('cacheSystem wraps a string system prompt in a cache_control block', async () => {
  await withUpstream(
    () => new Response('{"content":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    async (f, seen) => {
      const c = new ClaudeClient({ baseUrl: 'https://gw.test', model: 'm', fetchImpl: f });
      await c.messages({ system: 'You are a coach.', messages: [] }, { cacheSystem: true });
      const sent = JSON.parse(seen.upstream[0].init.body);
      assert.deepEqual(sent.system, [
        { type: 'text', text: 'You are a coach.', cache_control: { type: 'ephemeral' } }]);
    });
});

test('gateway rejections surface as readable errors', async () => {
  // 403: the client is pointed at a gateway that does not list its origin.
  await withUpstream(() => new Response('{}'), async f => {
    const c = new ClaudeClient({ baseUrl: 'https://gw.test', model: 'm', fetchImpl: f });
    await assert.rejects(() => c.messages({ messages: [] }),
      e => e instanceof ClaudeGatewayError && e.status === 403 && /ALLOWED_ORIGINS/.test(e.message));
  }, { ...ENV, ALLOWED_ORIGINS: 'https://other.example.com' });

  // 429: rate limited.
  _resetMemoryLimit();
  await withUpstream(() => new Response('{"content":[]}',
    { headers: { 'content-type': 'application/json' } }), async f => {
    const c = new ClaudeClient({ baseUrl: 'https://gw.test', model: 'm', fetchImpl: f });
    await c.messages({ messages: [] });
    await assert.rejects(() => c.messages({ messages: [] }),
      e => e.status === 429 && /Rate limited/.test(e.message));
  }, { ...ENV, RATE_LIMIT_PER_MIN: '1' });

  // 500: the deploy forgot the secret.
  await withUpstream(() => new Response('{}'), async f => {
    const c = new ClaudeClient({ baseUrl: 'https://gw.test', model: 'm', fetchImpl: f });
    await assert.rejects(() => c.messages({ messages: [] }),
      e => e.status === 500 && /no API key/.test(e.message));
  }, { ...ENV, ANTHROPIC_API_KEY: '' });
});

test('health() answers "is this URL right and is it configured"', async () => {
  await withUpstream(() => new Response('{}'), async f => {
    const c = new ClaudeClient({ baseUrl: 'https://gw.test', fetchImpl: f });
    const h = await c.health();
    assert.equal(h.ok, true);
    assert.equal(h.keyConfigured, true);
    assert.equal(h.service, 'claude-gateway');
  });
});

test('constructing without a baseUrl fails immediately', () => {
  assert.throws(() => new ClaudeClient({}), /baseUrl is required/);
  const c = new ClaudeClient({ baseUrl: 'https://gw.test/' });
  assert.equal(c.baseUrl, 'https://gw.test', 'trailing slash trimmed so URLs never double up');
});
