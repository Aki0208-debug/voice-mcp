# Security model

This fork is private-by-default. Voice generation is a paid external side effect and requires an authenticated subject plus a configured usage guard.

## Production invariants

- OAuth 2.1 JWT verification checks signature, issuer, audience, expiry/not-before, subject, algorithm allowlist, and every required scope.
- Missing OAuth configuration fails closed.
- `VOICE_GUARD` is mandatory for generation; missing KV fails closed before a provider is called.
- Direct generation is disabled unless explicitly enabled. Standalone panel, event polling, and history routes are not exposed.
- Direct generation accepts `POST` only. Voice text is not accepted in a URL.
- Provider logs include model, language, and character count, never the spoken text.
- Provider error bodies are not returned to callers or copied into logs.
- The public status response never exposes voice IDs, model settings, API-key state, or provider configuration.
- Text, request, and audio response sizes are bounded before large payloads reach the client.

## Development authentication

`ALLOW_INSECURE_DEV_AUTH=true` and `DEV_BEARER_TOKEN` exist only for local smoke tests. Do not configure either value on a deployed Worker. Production uses `OAUTH_ISSUER`, `OAUTH_AUDIENCE`, and `OAUTH_JWKS_URL`.

## Remaining operational controls

Set a provider-side spending cap and alert in addition to the Worker character limit. KV counters are a guardrail, not a billing ledger. Rotate TTS and OAuth credentials after any suspected exposure.
