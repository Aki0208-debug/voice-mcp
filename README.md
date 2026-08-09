# voice-mcp, private Work edition

A Cloudflare Worker MCP server that turns text into speech and returns a private inline audio player through the open MCP Apps bridge used by ChatGPT Work.

This branch is hardened for a single private deployment. It is not a drop-in public demo.

## What changed

- OAuth 2.1 resource metadata and JWT verification for the `speak` tool
- issuer, audience, expiry, algorithm, subject, and scope validation
- fail-closed KV usage guard with request and daily character limits
- bounded text, request body, and audio response sizes
- no full voice text in application logs
- no provider response bodies in client errors or logs
- generic public health response with no voice IDs or configuration details
- `POST`-only direct generation, disabled by default
- standalone panel, event polling, and ElevenLabs history routes removed from the deployed surface
- legacy `/sse` transport disabled; use streamable HTTP at `/mcp`
- dependency updates and a clean production audit

## Public surface

| Route | Default | Purpose |
| --- | --- | --- |
| `/mcp` | enabled | MCP streamable HTTP endpoint; `speak` itself requires OAuth |
| `/.well-known/oauth-protected-resource` | enabled | OAuth discovery metadata |
| `/status` | enabled | generic health only |
| `/speak` | disabled | authenticated direct audio API, `POST` only |
| `/panel`, `/events/latest`, `/history` | not exposed | upstream demo routes intentionally removed from the private deployment |

## Requirements

- Node.js 20 or newer
- Cloudflare Workers account
- one Cloudflare KV namespace for production (`VOICE_GUARD`)
- an established OAuth 2.1/OIDC provider such as Auth0 or Stytch
- DashScope/CosyVoice or ElevenLabs credentials

Do not implement a new identity provider inside this Worker. Configure an existing provider that can expose discovery metadata, issue JWT access tokens for the Worker audience, and support the MCP authorization flow.

## Install and verify

```bash
npm install
npm run check
npx wrangler deploy --dry-run
```

`npm run check` runs TypeScript validation, unit tests, and the production dependency audit.

## Cloudflare KV

Create a guard namespace and add the returned namespace ID to `wrangler.jsonc`:

```bash
npx wrangler kv namespace create VOICE_GUARD
```

```jsonc
"kv_namespaces": [
  { "binding": "VOICE_GUARD", "id": "<guard-namespace-id>" }
]
```

`VOICE_GUARD` is required. If it is absent, voice generation returns `503` before calling the paid provider.

## Production OAuth variables

Add these non-secret values to `wrangler.jsonc` or the Cloudflare dashboard:

```text
OAUTH_ISSUER=https://your-issuer.example
OAUTH_AUDIENCE=https://your-worker.example/mcp
OAUTH_JWKS_URL=https://your-issuer.example/.well-known/jwks.json
OAUTH_SCOPES=voice:generate
OAUTH_ALLOWED_ALGORITHMS=RS256
```

The authorization server must issue a token whose `aud` matches `OAUTH_AUDIENCE` and whose `scope` or `scp` includes every configured scope. ChatGPT discovers the authorization server through `/.well-known/oauth-protected-resource`.

## TTS secrets

Set secrets with Wrangler; never place them in `wrangler.jsonc`, `.dev.vars`, documentation, or git history.

DashScope/CosyVoice:

```bash
npx wrangler secret put DASHSCOPE_API_KEY
npx wrangler secret put VOICE_ID
```

Then set `TTS_PROVIDER=dashscope`. The default model is `cosyvoice-v3.5-plus`; override it with `TTS_MODEL` only after confirming the provider supports the selected voice and model together.

ElevenLabs:

```bash
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put ELEVENLABS_VOICE_ID_ZH
```

Then set `TTS_PROVIDER=elevenlabs`. Optional variables include `ELEVENLABS_VOICE_ID_EN`, `ELEVENLABS_MODEL_ID`, language codes, output format, stability, similarity boost, style, speaker boost, and speed.

## Local development only

Copy `.dev.vars.example` to `.dev.vars`, replace the placeholders, and keep `.dev.vars` untracked. Development bearer authentication is accepted only when both of these are present:

```text
ALLOW_INSECURE_DEV_AUTH=true
DEV_BEARER_TOKEN=<long-random-local-token>
```

Never deploy these two values. Production must use OAuth.

## Default guardrails

| Variable | Default |
| --- | ---: |
| `RATE_LIMIT_REQUESTS` | 10 |
| `RATE_LIMIT_WINDOW_SECONDS` | 60 |
| `DAILY_CHARACTER_LIMIT` | 20000 |
| `MAX_TEXT_CHARACTERS` | 600 |
| `MAX_REQUEST_BYTES` | 16384 |
| `MAX_AUDIO_BYTES` | 5242880 |

Also configure a provider-side spending cap and alerts. Worker KV counters are deliberately conservative but are not a substitute for the provider's billing controls.

## Connect to ChatGPT Work

1. Deploy the Worker to a public HTTPS URL.
2. Verify OAuth discovery and the `/mcp` endpoint with MCP Inspector.
3. In ChatGPT, enable Developer mode if the workspace policy allows it.
4. Add a plugin/MCP connection using `https://your-worker.example/mcp`.
5. Review the discovered `speak` tool and complete the OAuth link.
6. In a new conversation, request speech and confirm the inline player renders without console errors.

The result is an inline playable audio card, not a native ChatGPT voice-message object and not an unsolicited background push.

## License

MIT, following the upstream project.
