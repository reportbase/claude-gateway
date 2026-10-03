/* claude-client — the browser half of claude-gateway.
   ---------------------------------------------------------------------------
   Drop this in any app, point it at your Worker, and call Claude without ever
   holding an API key in the page:

     const claude = new ClaudeClient({ baseUrl: 'https://claude-gateway.tangent.workers.dev' });
     const j = await claude.messages({ model, max_tokens: 512, messages });
     await claude.stream({ model, max_tokens: 512, messages }, { onText: t => out(t) });

   No dependencies, no build step. Works as an ES module (`import`) or as a
   classic <script> (attaches window.ClaudeClient).

   Three pieces of hard-won behaviour are baked in, because every app that talks
   to Claude from a browser eventually needs all three:

   1. Clone-safe fetch. Some hosts (artifact viewers, sandboxed iframes) proxy
      fetch over postMessage, and an AbortSignal is not structured-cloneable —
      the call dies with DataCloneError. On that specific error we retry once
      without the signal and remember, so it costs one failure per session.
   2. Non-streamable responses. Those same proxied hosts hand back the whole
      body with no readable stream. The stream path detects it and parses
      either a buffered SSE transcript or plain message JSON.
   3. Prompt caching. `cacheSystem: true` wraps a string system prompt in a
      cache_control block, which is where the savings are for apps that send
      the same instructions on every turn. */

const DEFAULT_VERSION = '2023-06-01';

export class ClaudeGatewayError extends Error {
  constructor(message, status, type){
    super(message);
    this.name = 'ClaudeGatewayError';
    this.status = status || 0;
    this.type = type || 'error';
  }
}

export class ClaudeClient {
  /* opts:
       baseUrl    required — your Worker origin, no trailing /v1
       model      default model for calls that omit one
       maxTokens  default max_tokens
       version    anthropic-version header (rarely needs changing)
       fetchImpl  inject a fetch for tests */
  constructor(opts = {}){
    const base = String(opts.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('ClaudeClient: baseUrl is required');
    this.baseUrl = base;
    this.model = opts.model || null;
    this.maxTokens = opts.maxTokens || 1024;
    this.version = opts.version || DEFAULT_VERSION;
    this._fetch = opts.fetchImpl || ((...a) => fetch(...a));
    /* Set once a DataCloneError proves this host cannot pass an AbortSignal
       through its fetch proxy. From then on we stop trying. */
    this.noSignal = false;
  }

  _url(path){ return this.baseUrl + path; }

  _headers(){
    // Deliberately no x-api-key and no dangerous-direct-browser-access:
    // the Worker owns the credential. If you find yourself adding one here,
    // you have stopped using the gateway.
    return { 'content-type': 'application/json', 'anthropic-version': this.version };
  }

  _body(body, opts){
    const b = { ...body };
    if (!b.model) b.model = this.model;
    if (!b.max_tokens) b.max_tokens = this.maxTokens;
    if (!b.model) throw new Error('ClaudeClient: no model given and no default set');
    /* A string system prompt is the common case and the most cacheable thing
       in the request — the same instructions on every turn. Wrapping it costs
       nothing when the cache misses. */
    if (opts && opts.cacheSystem && typeof b.system === 'string' && b.system){
      b.system = [{ type: 'text', text: b.system, cache_control: { type: 'ephemeral' } }];
    }
    return b;
  }

  /* One fetch, retried without the signal if — and only if — this host's fetch
     cannot clone one. Any other error propagates untouched. */
  async _fetchSafe(url, init, signal){
    const go = withSignal => this._fetch(url, withSignal && signal ? { ...init, signal } : init);
    if (this.noSignal || !signal) return go(false);
    try { return await go(true); }
    catch (e){
      if (!/clon/i.test(String((e && e.message) || e))) throw e;
      this.noSignal = true;
      return go(false);
    }
  }

  async _throwForStatus(res){
    let msg = 'HTTP ' + res.status, type = 'api_error';
    try {
      const j = await res.json();
      if (j && j.error){ msg = j.error.message || msg; type = j.error.type || type; }
    } catch { /* non-JSON error body: the status line is all we have */ }
    if (res.status === 403) msg = 'This gateway rejected the request origin — check ALLOWED_ORIGINS. (' + msg + ')';
    if (res.status === 429) msg = 'Rate limited — try again shortly. (' + msg + ')';
    if (res.status === 500 && /ANTHROPIC_API_KEY/.test(msg)) msg = 'The gateway has no API key configured.';
    throw new ClaudeGatewayError(msg, res.status, type);
  }

  /* ── Non-streaming ──────────────────────────────────────────────────────
     Returns the parsed Message object exactly as the API shapes it, so tool
     use (`content[].type === 'tool_use'`) works unchanged. */
  async messages(body, opts = {}){
    const res = await this._fetchSafe(this._url('/v1/messages'), {
      method: 'POST', headers: this._headers(),
      body: JSON.stringify(this._body(body, opts)),
    }, opts.signal);
    if (!res.ok) await this._throwForStatus(res);
    return await res.json();
  }

  async countTokens(body, opts = {}){
    const res = await this._fetchSafe(this._url('/v1/messages/count_tokens'), {
      method: 'POST', headers: this._headers(),
      body: JSON.stringify(this._body(body, opts)),
    }, opts.signal);
    if (!res.ok) await this._throwForStatus(res);
    return await res.json();
  }

  /* ── Streaming ──────────────────────────────────────────────────────────
     opts.onText(chunk)  — called per text delta, the usual hook
     opts.onEvent(ev)    — called per decoded SSE event, for tool/usage watching
     opts.signal         — AbortSignal (dropped automatically on clone-hostile hosts)
     Resolves with the full concatenated text. */
  async stream(body, opts = {}){
    const onText = opts.onText || (() => {});
    const onEvent = opts.onEvent || (() => {});
    let full = '';
    const take = t => { if (t){ full += t; onText(t); } };

    const handleEvent = ev => {
      onEvent(ev);
      if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') take(ev.delta.text);
      else if (ev.type === 'error') throw new ClaudeGatewayError(
        (ev.error && ev.error.message) || 'stream error', 0, (ev.error && ev.error.type) || 'error');
    };
    const handleLine = line => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let ev; try { ev = JSON.parse(data); } catch { return; }
      handleEvent(ev);
    };

    const res = await this._fetchSafe(this._url('/v1/messages'), {
      method: 'POST', headers: this._headers(),
      body: JSON.stringify({ ...this._body(body, opts), stream: true }),
    }, opts.signal);
    if (!res.ok) await this._throwForStatus(res);

    if (res.body && res.body.getReader){
      const rd = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;){
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0){
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          handleLine(line);
        }
      }
      if (buf.trim()) handleLine(buf.trim());
      return full;
    }

    /* No readable stream in this environment: take the reply whole. It is
       either the SSE transcript buffered up, or plain message JSON if the
       host's proxy unwrapped the stream itself. */
    const text = (await res.text()).trim();
    if (text.startsWith('{')){
      let j = null;
      try { j = JSON.parse(text); } catch { /* fall through to SSE parsing */ }
      if (j && j.content){
        take(j.content.map(b => b.text || '').join(''));
        return full;
      }
    }
    for (const raw of text.split('\n')) handleLine(raw.trim());
    return full;
  }

  /* Is the gateway up and configured? Handy for a settings screen: it answers
     "is this URL right" and "did they remember the secret" in one call. */
  async health(){
    const res = await this._fetch(this._url('/health'), { method: 'GET' });
    if (!res.ok) await this._throwForStatus(res);
    return await res.json();
  }
}

export default ClaudeClient;

/* Classic-script convenience: <script src="claude-client.js"></script> */
if (typeof window !== 'undefined'){
  window.ClaudeClient = ClaudeClient;
  window.ClaudeGatewayError = ClaudeGatewayError;
}
