# claude-gateway

A small Cloudflare Worker that sits between your apps and the Anthropic API, plus a dependency-free browser client. The API key lives as a Worker secret, so no page you ship ever contains it, and every new app you write points at the same URL instead of re-solving CORS, streaming, and key storage.

You already have `hello-edge.tangent.workers.dev` deployed, so the toolchain is in place — this deploys the same way and will land at `https://claude-gateway.tangent.workers.dev`.

## Deploy

```bash
cd claude-gateway
npx wrangler secret put ANTHROPIC_API_KEY     # paste the key; it is encrypted at rest
npx wrangler deploy
curl https://claude-gateway.tangent.workers.dev/health
```

The health check is the fastest way to confirm a deploy took the config you meant:

```json
{ "ok": true, "keyConfigured": true, "allowedOrigins": 2,
  "rateLimitPerMin": 60, "rateLimiter": "in-isolate", "maxTokensCap": 4096 }
```

`keyConfigured: false` means the secret did not land. It never echoes the key itself.

Before it is useful from a browser, list the origins that may call it, in `wrangler.toml`:

```toml
ALLOWED_ORIGINS = "https://chess.tangent.dev,https://*.tangent.dev,http://localhost:8077"
```

then `npx wrangler deploy` again. Adding an app later is an edit to that one line — no code changes.

## Use it

```html
<script type="module">
  import { ClaudeClient } from './claude-client.js';

  const claude = new ClaudeClient({
    baseUrl: 'https://claude-gateway.tangent.workers.dev',
    model: 'claude-haiku-4-5',
    maxTokens: 512,
  });

  // Non-streaming — returns the Message object unchanged, so tool use works as-is.
  const j = await claude.messages({ messages: [{ role: 'user', content: 'Hello' }] });
  console.log(j.content[0].text);

  // Streaming — onText fires per delta; resolves with the full text.
  await claude.stream(
    { system: 'You are terse.', messages: [{ role: 'user', content: 'Explain en passant' }] },
    { onText: t => out.textContent += t, cacheSystem: true },
  );
</script>
```

`cacheSystem: true` wraps a string system prompt in a `cache_control` block. For an app that sends the same instructions every turn, that is where the savings are.

The client also handles two things that bite every browser app eventually. Some hosts — artifact viewers, sandboxed iframes — proxy `fetch` over `postMessage`, where an `AbortSignal` is not structured-cloneable and the call dies with `DataCloneError`; the client retries once without the signal and remembers, so it costs one failure per session. Those same hosts sometimes return no readable stream, so the streaming path detects that and parses either a buffered SSE transcript or plain message JSON.

## Configuration

Everything is in `[vars]` in `wrangler.toml`. All of it is policy you can change without touching code.

| Var | Default | What it does |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | localhost | Who may call. Exact origins, `https://*.example.com` wildcards, `null` for `file://` pages, `*` for dev only. |
| `RATE_LIMIT_PER_MIN` | `60` | Requests per IP+origin per minute. `0` disables. |
| `ALLOWED_MODELS` | *(any)* | Model allowlist. Cheapest protection against a runaway client. |
| `MAX_TOKENS_CAP` | `4096` | Ceiling on `max_tokens`. Requests above it are clamped, not rejected. |
| `MAX_BODY_BYTES` | `262144` | Largest accepted request body. |
| `ALLOWED_PATHS` | messages, count_tokens, models | Which upstream paths are reachable. |
| `ALLOW_NO_ORIGIN` | `false` | Permit callers with no `Origin` header (curl, servers, native apps). |

### Accurate rate limiting

The default limiter counts inside a single Worker isolate, so the true global ceiling is roughly *(isolates × limit)*. It is a speed bump, not a wall. Cloudflare's native binding counts across the whole edge and costs nothing — uncomment the `[[unsafe.bindings]]` block in `wrangler.toml` and redeploy. `/health` will then report `"rateLimiter": "binding"`.

## Security — the honest version

An origin allowlist stops **other websites** from spending your quota in a visitor's browser, because browsers set `Origin` themselves and will not let a page lie about it. That is a real and worthwhile protection, and it is the common case.

It does **not** stop `curl`, which can send any `Origin` string it likes. Anyone who discovers your Worker URL and reads your page's network tab can replay requests against it. The rate limit is what actually bounds the damage, so set `RATE_LIMIT_PER_MIN`, `ALLOWED_MODELS`, and `MAX_TOKENS_CAP` to values you would be comfortable seeing sustained by a stranger, and keep Anthropic spend limits on the key.

Listing `null` in `ALLOWED_ORIGINS` lets pages opened from `file://` through. Convenient for local single-file apps, but `null` is what *every* local file page sends, so it authenticates nothing. Use it for a personal machine, not a published Worker.

If you later need real authentication — native apps, or a Worker you cannot keep unlisted — the shape to add is a shared token per app: a `X-App-Key` header checked against a secret list, right after the origin check in `handleRequest`. It is about ten lines and does not disturb anything else here.

What the Worker guarantees regardless: the key is injected server-side and never returned; client-supplied `x-api-key` and `authorization` headers are dropped rather than forwarded, so nobody can smuggle a credential through; only allowlisted paths are reachable, so this is not an open proxy.

## Tests

```bash
npm test        # 24 tests, no network, no wrangler needed
```

The suite runs the Worker handler directly with a stubbed upstream, and runs the client *through the real Worker handler* rather than a mock of it. It covers origin matching (including that `https://evil-example.com` must not match `*.example.com`), key injection and credential stripping, the model allowlist and token clamp, body/path/method rejection, rate-limit windows and per-IP bucketing, error and 502 passthrough, and a timing assertion that SSE genuinely streams instead of buffering.

## Wiring an existing app to it

For the TVF chess app, the change is small and removes the key-in-localStorage problem in §3 of the session paper. Its `coachApiCall` and streaming path already match this client's shape:

- Replace the two `fetch('https://api.anthropic.com/v1/messages', …)` call sites with `claude.messages(body)` and `claude.stream(body, { onText })`.
- Delete the `x-api-key` and `anthropic-dangerous-direct-browser-access` headers — the Worker supplies the first and the second is no longer needed.
- Drop the `COACH.noSignal` logic and the non-streamable fallback; both now live in the client.
- The menu's API-key field becomes a gateway-URL field (or disappears entirely, hard-coded).

Add `file://`-served builds to `ALLOWED_ORIGINS` as `null` if you open the standalone build directly, with the caveat above in mind.
