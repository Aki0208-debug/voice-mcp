import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const executionContext = {} as ExecutionContext;

async function parseMcpResponse(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (response.headers.get("Content-Type")?.includes("application/json")) {
    return JSON.parse(raw) as Record<string, unknown>;
  }
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  assert.ok(dataLine);
  return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
}

test("public status is generic and sensitive APIs are disabled by default", async () => {
  const status = await worker.fetch(new Request("https://voice.example/status"), {}, executionContext);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    status: "ok",
    service: "voice-mcp",
    version: "1.1.0",
    authentication: "not_configured",
  });

  assert.equal((await worker.fetch(new Request("https://voice.example/speak"), {}, executionContext)).status, 404);
  assert.equal((await worker.fetch(new Request("https://voice.example/panel"), {}, executionContext)).status, 404);
});

test("OAuth protected resource metadata is discoverable", async () => {
  const response = await worker.fetch(new Request("https://voice.example/.well-known/oauth-protected-resource"), {
    OAUTH_ISSUER: "https://issuer.example",
    OAUTH_SCOPES: "voice:generate",
  }, executionContext);
  assert.equal(response.status, 200);
  const metadata = await response.json() as Record<string, unknown>;
  assert.equal(metadata.resource, "https://voice.example/mcp");
  assert.deepEqual(metadata.authorization_servers, ["https://issuer.example"]);
});

test("enabled direct API rejects unauthenticated requests before provider access", async () => {
  const response = await worker.fetch(new Request("https://voice.example/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  }), {
    ENABLE_DIRECT_API: "true",
    OAUTH_ISSUER: "https://issuer.example",
    OAUTH_AUDIENCE: "https://voice.example/mcp",
    OAUTH_JWKS_URL: "https://issuer.example/.well-known/jwks.json",
  }, executionContext);

  assert.equal(response.status, 401);
  assert.match(response.headers.get("WWW-Authenticate") || "", /oauth-protected-resource/);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
});

test("legacy SSE transport and GET voice generation stay closed", async () => {
  assert.equal((await worker.fetch(new Request("https://voice.example/sse"), {}, executionContext)).status, 410);

  const getSpeak = await worker.fetch(new Request("https://voice.example/speak"), {
    ENABLE_DIRECT_API: "true",
  }, executionContext);
  assert.equal(getSpeak.status, 405);
  assert.equal(getSpeak.headers.get("Allow"), "POST");
});

test("MCP discovery advertises the inline player and OAuth requirement", async () => {
  const env = {
    OAUTH_ISSUER: "https://issuer.example",
    OAUTH_AUDIENCE: "https://voice.example/mcp",
    OAUTH_JWKS_URL: "https://issuer.example/.well-known/jwks.json",
  };
  const initialize = await worker.fetch(new Request("https://voice.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    }),
  }), env, executionContext);
  assert.equal(initialize.status, 200);

  const tools = await worker.fetch(new Request("https://voice.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  }), env, executionContext);
  assert.equal(tools.status, 200);
  const payload = await parseMcpResponse(tools) as {
    result?: { tools?: Array<{ name?: string; _meta?: Record<string, unknown> }> };
  };
  const speak = payload.result?.tools?.find((tool) => tool.name === "speak");
  assert.ok(speak);
  assert.equal((speak._meta?.ui as { resourceUri?: string })?.resourceUri, "ui://voice-mcp/player-v2.html");
  assert.deepEqual(speak._meta?.securitySchemes, [{ type: "oauth2", scopes: ["voice:generate"] }]);

  const resource = await worker.fetch(new Request("https://voice.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "resources/read",
      params: { uri: "ui://voice-mcp/player-v2.html" },
    }),
  }), env, executionContext);
  const resourcePayload = await parseMcpResponse(resource) as {
    result?: { contents?: Array<{ mimeType?: string; text?: string }> };
  };
  assert.equal(resourcePayload.result?.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
  assert.match(resourcePayload.result?.contents?.[0]?.text || "", /ui\/notifications\/tool-result/);
});

test("MCP speak returns an OAuth challenge before provider access", async () => {
  const response = await worker.fetch(new Request("https://voice.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "speak", arguments: { text: "hello" } },
    }),
  }), {
    OAUTH_ISSUER: "https://issuer.example",
    OAUTH_AUDIENCE: "https://voice.example/mcp",
    OAUTH_JWKS_URL: "https://issuer.example/.well-known/jwks.json",
  }, executionContext);

  assert.equal(response.status, 200);
  const payload = await parseMcpResponse(response) as {
    result?: { isError?: boolean; _meta?: Record<string, unknown> };
  };
  assert.equal(payload.result?.isError, true);
  const challenges = payload.result?._meta?.["mcp/www_authenticate"] as string[] | undefined;
  assert.ok(challenges?.[0]?.includes("oauth-protected-resource"));
});

test("authenticated MCP speak fails closed when the usage guard is absent", async () => {
  const response = await worker.fetch(new Request("https://voice.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": "Bearer local-test-token",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "speak", arguments: { text: "hello" } },
    }),
  }), {
    ALLOW_INSECURE_DEV_AUTH: "true",
    DEV_BEARER_TOKEN: "local-test-token",
  }, executionContext);

  assert.equal(response.status, 200);
  const payload = await parseMcpResponse(response) as {
    result?: { isError?: boolean; structuredContent?: { error?: string } };
  };
  assert.equal(payload.result?.isError, true);
  assert.equal(payload.result?.structuredContent?.error, "Usage guard is not configured");
});
