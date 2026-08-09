import assert from "node:assert/strict";
import test from "node:test";
import {
  authenticateAuthorization,
  getAuthConfigurationError,
  getProtectedResourceMetadata,
} from "../src/security.ts";

const developmentEnv = {
  ALLOW_INSECURE_DEV_AUTH: "true",
  DEV_BEARER_TOKEN: "local-test-token",
  OAUTH_SCOPES: "voice:generate",
};

test("development bearer authentication is explicit and exact", async () => {
  const accepted = await authenticateAuthorization("Bearer local-test-token", developmentEnv);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.context.subject, "local-development");
    assert.deepEqual(accepted.context.scopes, ["voice:generate"]);
  }

  const missing = await authenticateAuthorization(undefined, developmentEnv);
  assert.deepEqual(missing, { ok: false, error: "missing_token" });

  const rejected = await authenticateAuthorization("Bearer local-test-token-extra", developmentEnv);
  assert.deepEqual(rejected, { ok: false, error: "invalid_token" });
});

test("production authentication fails closed when OAuth configuration is incomplete", () => {
  assert.match(getAuthConfigurationError({}), /OAUTH_ISSUER/);
  assert.equal(getAuthConfigurationError({
    OAUTH_ISSUER: "https://issuer.example",
    OAUTH_AUDIENCE: "https://voice.example/mcp",
    OAUTH_JWKS_URL: "https://issuer.example/.well-known/jwks.json",
  }), undefined);
});

test("protected resource metadata is scoped to the MCP endpoint", () => {
  const metadata = getProtectedResourceMetadata("https://voice.example", {
    OAUTH_ISSUER: "https://issuer.example/",
    OAUTH_SCOPES: "voice:generate voice:history",
  });
  assert.equal(metadata.resource, "https://voice.example/mcp");
  assert.deepEqual(metadata.authorization_servers, ["https://issuer.example/"]);
  assert.deepEqual(metadata.scopes_supported, ["voice:generate", "voice:history"]);
});
