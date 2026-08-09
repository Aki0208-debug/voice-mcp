import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthEnv {
  OAUTH_ISSUER?: string;
  OAUTH_AUDIENCE?: string;
  OAUTH_JWKS_URL?: string;
  OAUTH_SCOPES?: string;
  OAUTH_ALLOWED_ALGORITHMS?: string;
  ALLOW_INSECURE_DEV_AUTH?: string;
  DEV_BEARER_TOKEN?: string;
}

export interface AuthContext {
  subject: string;
  scopes: string[];
  mode: "oauth" | "development";
}

export type AuthResult =
  | { ok: true; context: AuthContext }
  | { ok: false; error: "missing_token" | "invalid_token" | "insufficient_scope" | "auth_not_configured" };

const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function parseWords(value: string | undefined): string[] {
  return (value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getRemoteJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = remoteJwks.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
    remoteJwks.set(url, jwks);
  }
  return jwks;
}

function extractBearer(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || undefined;
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const size = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < size; index++) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }

  return difference === 0;
}

export function getRequiredScopes(env: AuthEnv): string[] {
  const configured = parseWords(env.OAUTH_SCOPES);
  return configured.length ? configured : ["voice:generate"];
}

export function getAuthConfigurationError(env: AuthEnv): string | undefined {
  const developmentEnabled = env.ALLOW_INSECURE_DEV_AUTH?.trim().toLowerCase() === "true";
  if (developmentEnabled && env.DEV_BEARER_TOKEN) return undefined;

  const missing = [
    ["OAUTH_ISSUER", env.OAUTH_ISSUER],
    ["OAUTH_AUDIENCE", env.OAUTH_AUDIENCE],
    ["OAUTH_JWKS_URL", env.OAUTH_JWKS_URL],
  ].filter(([, value]) => !value).map(([name]) => name);

  return missing.length ? `Missing authentication configuration: ${missing.join(", ")}` : undefined;
}

export function getProtectedResourceMetadata(origin: string, env: AuthEnv): Record<string, unknown> {
  const authorizationServers = env.OAUTH_ISSUER ? [env.OAUTH_ISSUER] : [];
  return {
    resource: `${origin}/mcp`,
    authorization_servers: authorizationServers,
    scopes_supported: getRequiredScopes(env),
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/`,
  };
}

export function getAuthChallenge(
  origin: string,
  error: "invalid_token" | "insufficient_scope" = "invalid_token",
  description = "Authentication is required to use the voice service",
): string {
  const escapedDescription = description.replace(/["\\\r\n]/g, " ");
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", error="${error}", error_description="${escapedDescription}"`;
}

export async function authenticateAuthorization(
  authorization: string | null | undefined,
  env: AuthEnv,
): Promise<AuthResult> {
  const token = extractBearer(authorization);
  if (!token) return { ok: false, error: "missing_token" };

  const developmentEnabled = env.ALLOW_INSECURE_DEV_AUTH?.trim().toLowerCase() === "true";
  if (developmentEnabled && env.DEV_BEARER_TOKEN && constantTimeEqual(token, env.DEV_BEARER_TOKEN)) {
    return {
      ok: true,
      context: {
        subject: "local-development",
        scopes: getRequiredScopes(env),
        mode: "development",
      },
    };
  }

  if (getAuthConfigurationError(env)) return { ok: false, error: "auth_not_configured" };

  try {
    const requiredScopes = getRequiredScopes(env);
    const algorithms = parseWords(env.OAUTH_ALLOWED_ALGORITHMS);
    const { payload } = await jwtVerify(token, getRemoteJwks(env.OAUTH_JWKS_URL!), {
      issuer: env.OAUTH_ISSUER!,
      audience: env.OAUTH_AUDIENCE!,
      algorithms: algorithms.length ? algorithms : ["RS256"],
      clockTolerance: 5,
    });

    if (!payload.sub) return { ok: false, error: "invalid_token" };

    const scopes = new Set<string>();
    if (typeof payload.scope === "string") {
      for (const scope of parseWords(payload.scope)) scopes.add(scope);
    }
    const scopedPayload = payload as typeof payload & { scp?: unknown };
    if (Array.isArray(scopedPayload.scp)) {
      for (const scope of scopedPayload.scp) {
        if (typeof scope === "string") scopes.add(scope);
      }
    }

    if (!requiredScopes.every((scope) => scopes.has(scope))) {
      return { ok: false, error: "insufficient_scope" };
    }

    return {
      ok: true,
      context: {
        subject: payload.sub,
        scopes: Array.from(scopes),
        mode: "oauth",
      },
    };
  } catch {
    return { ok: false, error: "invalid_token" };
  }
}
