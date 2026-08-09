export interface GuardEnv {
  VOICE_GUARD?: KVNamespace;
  RATE_LIMIT_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
  DAILY_CHARACTER_LIMIT?: string;
  MAX_TEXT_CHARACTERS?: string;
  MAX_AUDIO_BYTES?: string;
}

interface DailyUsage {
  characters: number;
}

export type GuardResult =
  | { ok: true }
  | { ok: false; status: 429 | 503; error: string; retryAfter?: number };

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function hashSubject(subject: string): Promise<string> {
  const bytes = new TextEncoder().encode(subject);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function getMaxTextCharacters(env: GuardEnv): number {
  return parsePositiveInteger(env.MAX_TEXT_CHARACTERS, 600);
}

export function getMaxAudioBytes(env: GuardEnv): number {
  return parsePositiveInteger(env.MAX_AUDIO_BYTES, 5 * 1024 * 1024);
}

export async function enforceUsageLimits(env: GuardEnv, subject: string, characters: number): Promise<GuardResult> {
  if (!env.VOICE_GUARD) {
    return { ok: false, status: 503, error: "Usage guard is not configured" };
  }

  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const subjectHash = await hashSubject(subject);
    const windowSeconds = parsePositiveInteger(env.RATE_LIMIT_WINDOW_SECONDS, 60);
    const requestLimit = parsePositiveInteger(env.RATE_LIMIT_REQUESTS, 10);
    const windowId = Math.floor(nowSeconds / windowSeconds);
    const rateKey = `rate:${subjectHash}:${windowId}`;
    const currentRate = Number.parseInt(await env.VOICE_GUARD.get(rateKey) || "0", 10) || 0;

    if (currentRate >= requestLimit) {
      const retryAfter = windowSeconds - (nowSeconds % windowSeconds);
      return { ok: false, status: 429, error: "Voice request rate limit exceeded", retryAfter };
    }

    const date = new Date().toISOString().slice(0, 10);
    const dailyKey = `daily:${subjectHash}:${date}`;
    const storedDaily = await env.VOICE_GUARD.get<DailyUsage>(dailyKey, "json");
    const currentCharacters = Number.isSafeInteger(storedDaily?.characters) && storedDaily!.characters >= 0
      ? storedDaily!.characters
      : 0;
    const dailyLimit = parsePositiveInteger(env.DAILY_CHARACTER_LIMIT, 20_000);

    if (currentCharacters + characters > dailyLimit) {
      return { ok: false, status: 429, error: "Daily voice character limit exceeded" };
    }

    await Promise.all([
      env.VOICE_GUARD.put(rateKey, String(currentRate + 1), { expirationTtl: windowSeconds + 30 }),
      env.VOICE_GUARD.put(dailyKey, JSON.stringify({ characters: currentCharacters + characters }), { expirationTtl: 172_800 }),
    ]);

    return { ok: true };
  } catch {
    return { ok: false, status: 503, error: "Usage guard is temporarily unavailable" };
  }
}

export function estimateBase64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
}
