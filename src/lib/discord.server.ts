import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { BOT_DEFAULTS } from "./bot-defaults.server";

export const DISCORD_API = "https://discord.com/api/v10";

// ---------- Discord rate-limit guard ----------
// Discord bans an IP for a while when it sends too many requests or too many failing ones
// (401/403/429). This guard makes PEAK stop on its own long before that:
// - after any global / Cloudflare 429 every call pauses until Discord says it is OK again,
// - per-route buckets are honoured from the X-RateLimit headers,
// - a rejected bot token is never retried until a new token is saved,
// - too many failing calls in 10 minutes pause everything for a while.
let pausedUntil = 0;
const buckets = new Map<string, number>(); // route -> time it is allowed again
const failures: number[] = [];
const FAIL_WINDOW = 10 * 60_000;
const FAIL_LIMIT = 300; // Discord's own limit is 10,000 per 10 minutes; stay far below it
const rejectedTokens = new Set<string>();

export class DiscordPausedError extends Error {}

function routeKey(path: string, init: RequestInit) {
  const auth = String((init.headers as Record<string, string> | undefined)?.["Authorization"] ?? "").slice(0, 16);
  return `${init.method ?? "GET"} ${path.split("?")[0]} ${auth}`;
}

function pauseMessage() {
  return `Discord asked PEAK to slow down. All Discord requests are paused until ${new Date(pausedUntil).toISOString().slice(11, 16)} UTC and will resume on their own — please don't retry until then.`;
}

export function discordPausedUntil() {
  return pausedUntil > Date.now() ? pausedUntil : 0;
}

function noteFailure() {
  const now = Date.now();
  failures.push(now);
  while (failures.length && now - failures[0]! > FAIL_WINDOW) failures.shift();
  if (failures.length >= FAIL_LIMIT) {
    pausedUntil = Math.max(pausedUntil, now + FAIL_WINDOW);
    failures.length = 0;
  }
}

/** Discord REST call that respects every rate limit and never hammers the API. */
export async function dfetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  if (Date.now() < pausedUntil) throw new DiscordPausedError(pauseMessage());
  const key = routeKey(path, init);
  const waitBucket = (buckets.get(key) ?? 0) - Date.now();
  if (waitBucket > 0) {
    if (waitBucket > 5000) throw new DiscordPausedError("Discord limit for this action reached. Try again in a few seconds.");
    await new Promise((r) => setTimeout(r, waitBucket));
  }

  const res = await fetch(`${DISCORD_API}${path}`, init);

  const remaining = res.headers.get("x-ratelimit-remaining");
  const resetAfter = Number(res.headers.get("x-ratelimit-reset-after") ?? 0);
  if (remaining === "0" && resetAfter > 0) buckets.set(key, Date.now() + resetAfter * 1000 + 100);
  if (buckets.size > 2000) buckets.clear();

  if (res.status === 401 || res.status === 403) noteFailure();
  if (res.status !== 429) return res;

  noteFailure();
  const body = (await res.clone().json().catch(() => ({}))) as { retry_after?: number; global?: boolean; code?: number };
  const retryAfter = Number(res.headers.get("retry-after") ?? body.retry_after ?? 0) || 0;
  const scope = res.headers.get("x-ratelimit-scope");
  const isGlobal = body.global === true || res.headers.get("x-ratelimit-global") === "true";
  // No scope header = Cloudflare-level block of the server's IP (the "You are being blocked" message).
  const ipBlock = !scope && !isGlobal;
  if (isGlobal || ipBlock) {
    const minPause = ipBlock ? 30 * 60_000 : 5_000;
    pausedUntil = Math.max(pausedUntil, Date.now() + Math.max(retryAfter * 1000, minPause));
    console.error(`Discord ${ipBlock ? "IP block" : "global limit"}: pausing all Discord calls for ${Math.round((pausedUntil - Date.now()) / 1000)}s`);
    throw new DiscordPausedError(pauseMessage());
  }
  buckets.set(key, Date.now() + retryAfter * 1000 + 250);
  if (attempt === 0 && retryAfter <= 3) {
    await new Promise((r) => setTimeout(r, retryAfter * 1000 + 250));
    return dfetch(path, init, 1);
  }
  throw new DiscordPausedError("Discord limit for this action reached. Try again in a few seconds.");
}

/** Bot tokens start with the application ID in base64, so the Client ID can be checked against it. */
export function appIdFromToken(token: string | null | undefined): string | null {
  const first = (token ?? "").trim().split(".")[0];
  if (!first) return null;
  try {
    const b64 = first.replace(/-/g, "+").replace(/_/g, "/");
    const id = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return /^\d{17,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function forgetRejectedToken() {
  rejectedTokens.clear();
}

function supabaseProjectRef() {
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(process.env["SUPABASE_URL"] ?? "");
  return m ? m[1] : "unknown";
}

async function readBotConfigRow() {
  const { data, error } = await supabaseAdmin.from("bot_config").select("*").eq("id", 1).abortSignal(AbortSignal.timeout(8000)).single();
  if (error) {
    if (/schema cache|does not exist|relation/i.test(error.message)) {
      throw new Error(
        `Database is not set up yet: the bot_config table is missing in Supabase project "${supabaseProjectRef()}" (from SUPABASE_URL on the server). Run the setup SQL in that project, or point SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the project where you ran it.`,
      );
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error("Database is not set up yet: run the setup SQL in the Supabase SQL Editor.");
  return data;
}

type BotConfig = {
  id: number;
  client_id: string | null;
  client_secret: string | null;
  bot_token: string | null;
  sync_key: string | null;
  last_bot_ping: string | null;
  updated_at: string | null;
  /** Set when the database could not be read; the starting values are used instead. */
  dbError: string | null;
};

function pick(dbValue: string | null | undefined, envName: string, fallback: string) {
  const fromDb = (dbValue ?? "").trim();
  if (fromDb) return fromDb;
  const fromEnv = (process.env[envName] ?? "").trim();
  return fromEnv || fallback || null;
}

/**
 * Bot details: values saved from the admin panel win, then env vars, then the starting values.
 * Never throws, so Discord login keeps working even while the database has a problem.
 */
export async function getBotConfig(): Promise<BotConfig> {
  let row: Awaited<ReturnType<typeof readBotConfigRow>> | null = null;
  let dbError: string | null = null;
  try {
    row = await readBotConfigRow();
  } catch (e) {
    dbError = (e as Error).message;
    console.error("bot_config unavailable:", dbError);
  }
  const bot_token = pick(row?.bot_token, "DISCORD_BOT_TOKEN", BOT_DEFAULTS.bot_token);
  // The token always belongs to exactly one application, so its ID wins over a mistyped Client ID.
  const client_id = appIdFromToken(bot_token) ?? pick(row?.client_id, "DISCORD_CLIENT_ID", BOT_DEFAULTS.client_id);
  return {
    id: 1,
    client_id,
    client_secret: pick(row?.client_secret, "DISCORD_CLIENT_SECRET", BOT_DEFAULTS.client_secret),
    bot_token,
    sync_key: row?.sync_key ?? null,
    last_bot_ping: row?.last_bot_ping ?? null,
    updated_at: row?.updated_at ?? null,
    dbError,
  };
}

export async function botFetch(path: string, init: RequestInit = {}) {
  const cfg = await getBotConfig();
  if (!cfg.bot_token) throw new Error("Bot token is not configured yet. Open the admin panel to add it.");
  if (rejectedTokens.has(cfg.bot_token)) {
    throw new Error("Discord rejected the bot token. Save a new token in the admin panel (Developer Portal → Bot → Reset Token).");
  }
  const res = await dfetch(path, {
    ...init,
    headers: { Authorization: `Bot ${cfg.bot_token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 401) {
    rejectedTokens.add(cfg.bot_token);
    clearBotGuildCache();
  }
  return res;
}

// ---------- small in-memory caches (keeps Discord API calls low so the app never gets rate-limited) ----------
type CacheEntry<T> = { at: number; value: T };
const botGuildCache: { entry?: CacheEntry<{ id: string; name: string; icon: string | null }[]> | undefined } = {};
const BOT_GUILDS_TTL = 60_000;

export function clearBotGuildCache() {
  botGuildCache.entry = undefined;
}

async function fetchBotGuildIds(): Promise<{ id: string; name: string; icon: string | null }[]> {
  const out: { id: string; name: string; icon: string | null }[] = [];
  let after = "0";
  for (let i = 0; i < 10; i++) {
    const res = await botFetch(`/users/@me/guilds?limit=200&after=${after}`);
    if (res.status === 401) throw new Error("Discord rejected the bot token. Save a new token in the admin panel.");
    if (!res.ok) throw new Error(`Discord error ${res.status}`);
    const page = (await res.json()) as { id: string; name: string; icon: string | null }[];
    out.push(...page);
    if (page.length < 200) break;
    after = page[page.length - 1]!.id;
  }
  return out;
}

export async function botGuildIds(): Promise<{ id: string; name: string; icon: string | null }[]> {
  const e = botGuildCache.entry;
  if (e && Date.now() - e.at < BOT_GUILDS_TTL) return e.value;
  let value;
  try {
    value = await fetchBotGuildIds();
  } catch (err) {
    if (e) return e.value; // keep showing the last good list instead of asking Discord again
    throw err;
  }
  botGuildCache.entry = { at: Date.now(), value };
  return value;
}

export type UserGuild = { id: string; name: string; icon: string | null; owner: boolean; permissions: string };
// Per-user guild list cache. Discord limits GET /users/@me/guilds strictly, so reuse a fresh copy.
const userGuildCache = new Map<string, CacheEntry<UserGuild[]>>();
const USER_GUILDS_TTL = 60_000;

/** Returns null when the user's Discord access token is no longer valid (401). */
export async function userGuilds(userId: string, accessToken: string, force = false): Promise<UserGuild[] | null> {
  const e = userGuildCache.get(userId);
  if (!force && e && Date.now() - e.at < USER_GUILDS_TTL) return e.value;
  let res: Response;
  try {
    res = await dfetch("/users/@me/guilds", { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    if (e) return e.value;
    throw err;
  }
  if (res.status === 401) {
    userGuildCache.delete(userId);
    return null;
  }
  if (!res.ok) {
    // Fall back to the last good copy instead of retrying Discord.
    if (e) return e.value;
    throw new Error(`Discord error ${res.status}`);
  }
  const value = (await res.json()) as UserGuild[];
  userGuildCache.set(userId, { at: Date.now(), value });
  if (userGuildCache.size > 5000) {
    const oldest = userGuildCache.keys().next().value;
    if (oldest) userGuildCache.delete(oldest);
  }
  return value;
}

export function requestOrigin(request: Request) {
  const url = new URL(request.url);
  const sandboxHost = url.hostname === "localhost" ? request.headers.get("x-forwarded-host") : null;
  return sandboxHost ? `https://${sandboxHost}` : url.origin;
}

/**
 * Public address of the site. Uses SITE_URL when set (recommended on Render / custom domains),
 * otherwise the request origin, forced to https behind a TLS-terminating proxy.
 */
export function siteOrigin(request: Request) {
  const env = (process.env["SITE_URL"] ?? "").trim().replace(/\/+$/, "").replace(/\/#$/, "");
  if (/^https?:\/\/[^/]+$/i.test(env)) return env;
  const origin = requestOrigin(request);
  const proto = request.headers.get("x-forwarded-proto");
  if (origin.startsWith("http://") && proto === "https") return origin.replace(/^http:/, "https:");
  return origin;
}

/** Redirect with mutable headers so the session cookie can be attached (Response.redirect is immutable). */
export function redirectTo(location: string, status = 302) {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": "no-store" } });
}
