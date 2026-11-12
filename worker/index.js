const SESSION_COOKIE = "sw_admin_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_MONITORS = 100;
const MAX_HISTORY = 500;
const MAX_URL_LENGTH = 2048;
const MAX_JSON_BYTES = 8192;

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(origin, env) {
  const allowed = allowedOrigins(env);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
  };
  if (origin && allowed.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status, origin, env, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin, env),
      ...extraHeaders,
    },
  });
}

function isAllowedOrigin(origin, env) {
  return Boolean(origin) && allowedOrigins(env).includes(origin);
}

function requireAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  return isAllowedOrigin(origin, env);
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > MAX_JSON_BYTES) throw new Error("Request body is too large.");
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new Error("Request body is too large.");
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error("Request body must contain valid JSON.");
  }
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function createSession(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET is not configured correctly.");
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: "owner", iat: now, exp: now + SESSION_TTL_SECONDS };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(env.SESSION_SECRET);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
  return `${encoded}.${base64UrlEncode(signature)}`;
}

async function verifySession(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie || !env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return false;
  const token = cookie.slice(SESSION_COOKIE.length + 1);
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const key = await hmacKey(env.SESSION_SECRET);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(parts[1]),
      new TextEncoder().encode(parts[0]),
    );
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
    return payload.sub === "owner" && Number.isInteger(payload.exp) && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function constantTimeStringEqual(a, b) {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function enforceRateLimit(request, env) {
  if (!env.CHECK_LIMITER) return false;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const result = await env.CHECK_LIMITER.limit({ key: ip });
  return result.success;
}

function validatePublicUrl(input) {
  if (typeof input !== "string" || input.length < 8 || input.length > MAX_URL_LENGTH) {
    throw new Error(`Enter a URL between 8 and ${MAX_URL_LENGTH} characters.`);
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid website URL, including https://.");
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Only HTTP and HTTPS websites are supported.");
  if (url.username || url.password) throw new Error("URLs containing usernames or passwords are not allowed.");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Only standard web ports 80 and 443 are allowed.");
  if (url.hash) url.hash = "";

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const blockedSuffixes = [
    ".localhost", ".local", ".internal", ".lan", ".home", ".test", ".example", ".invalid", ".onion", ".arpa",
  ];
  if (!host || host === "localhost" || blockedSuffixes.some((suffix) => host.endsWith(suffix))) {
    throw new Error("Local, private, and reserved network hostnames cannot be monitored.");
  }
  // Reject IPv4, IPv6, and non-canonical numeric host forms (decimal, octal, or hexadecimal).
  if (host.includes(":") || /^\d+(?:\.\d+){0,3}$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    throw new Error("Enter a public domain name rather than an IP address.");
  }
  if (!host.includes(".") || host.length > 253) throw new Error("Enter a fully qualified public domain name.");
  const labels = host.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    throw new Error("The website hostname is not valid.");
  }
  url.hostname = host;
  return url;
}

async function checkUrl(input) {
  const url = validatePublicUrl(input);
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    let response;
    try {
      response = await fetch(url.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "StatusWatch-Monitor/1.0",
          "Range": "bytes=0-0",
        },
      });
    } catch (error) {
      return {
        ok: false,
        reachable: false,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        error: error.name === "AbortError" ? "Request timed out." : "The website could not be reached.",
      };
    }
    const latencyMs = Date.now() - started;
    return {
      ok: response.status >= 200 && response.status < 400,
      reachable: true,
      httpStatus: response.status,
      latencyMs,
      checkedAt: new Date().toISOString(),
      redirected: response.status >= 300 && response.status < 400,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function validMonitorId(id) {
  return /^[0-9a-f-]{36}$/i.test(id || "");
}

async function getMonitor(env, id) {
  const raw = await env.MONITORS.get(`monitor:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function getMonitorCount(env) {
  const result = await env.MONITORS.list({ prefix: "monitor:", limit: MAX_MONITORS + 1 });
  return result.keys.length;
}

async function listPublicMonitors(env) {
  const list = await env.MONITORS.list({ prefix: "monitor:", limit: MAX_MONITORS });
  const items = await Promise.all(list.keys.map(async (key) => {
    const monitor = await getMonitor(env, key.name.slice("monitor:".length));
    if (!monitor || !monitor.enabled) return null;
    const rawHistory = await env.MONITORS.get(`history:${monitor.id}`);
    const history = rawHistory ? JSON.parse(rawHistory) : [];
    const latest = history.length ? history[history.length - 1] : null;
    return {
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      createdAt: monitor.createdAt,
      enabled: monitor.enabled,
      latest,
    };
  }));
  return items.filter(Boolean);
}

async function saveCheck(env, monitor, result) {
  const historyKey = `history:${monitor.id}`;
  const raw = await env.MONITORS.get(historyKey);
  const history = raw ? JSON.parse(raw) : [];
  history.push(result);
  await env.MONITORS.put(historyKey, JSON.stringify(history.slice(-MAX_HISTORY)));
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin, env)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (origin && !isAllowedOrigin(origin, env)) {
      return json({ error: "Origin not allowed." }, 403, origin, env);
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, service: "StatusWatch API", time: new Date().toISOString() }, 200, origin, env);
      }

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        if (!requireAllowedOrigin(request, env)) return json({ error: "A trusted website origin is required." }, 403, origin, env);
        if (!(await enforceRateLimit(request, env))) return json({ error: "Too many requests. Try again later." }, 429, origin, env);
        if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 16) {
          return json({ error: "ADMIN_PASSWORD is not configured. Contact the site administrator." }, 503, origin, env);
        }
        const body = await readJson(request);
        const supplied = typeof body.password === "string" ? body.password : "";
        if (!(await constantTimeStringEqual(supplied, env.ADMIN_PASSWORD))) {
          return json({ error: "Invalid password." }, 401, origin, env);
        }
        const token = await createSession(env);
        return json({ ok: true, authenticated: true }, 200, origin, env, { "Set-Cookie": sessionCookie(token) });
      }

      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        if (!requireAllowedOrigin(request, env)) return json({ error: "A trusted website origin is required." }, 403, origin, env);
        return json({ ok: true }, 200, origin, env, { "Set-Cookie": clearSessionCookie() });
      }

      if (url.pathname === "/api/auth/me" && request.method === "GET") {
        const authenticated = await verifySession(request, env);
        return json({ authenticated }, 200, origin, env);
      }

      // Public read-only status information; administrative actions require the owner session.
      if (url.pathname === "/api/monitors" && request.method === "GET") {
        return json({ monitors: await listPublicMonitors(env) }, 200, origin, env);
      }

      if (url.pathname === "/api/history" && request.method === "GET") {
        const id = url.searchParams.get("id");
        if (!validMonitorId(id)) return json({ error: "A valid monitor id is required." }, 400, origin, env);
        const monitor = await getMonitor(env, id);
        if (!monitor || !monitor.enabled) return json({ error: "Monitor not found." }, 404, origin, env);
        const raw = await env.MONITORS.get(`history:${id}`);
        return json({ history: raw ? JSON.parse(raw) : [] }, 200, origin, env);
      }

      const authenticated = await verifySession(request, env);
      const isAdminRoute =
        (url.pathname === "/api/monitors" && request.method === "POST") ||
        (url.pathname.startsWith("/api/monitors/") && request.method === "DELETE") ||
        (url.pathname === "/api/check" && request.method === "POST");

      if (isAdminRoute) {
        if (!requireAllowedOrigin(request, env)) return json({ error: "A trusted website origin is required." }, 403, origin, env);
        if (!authenticated) return json({ error: "Administrator login required." }, 401, origin, env);
        if (!(await enforceRateLimit(request, env))) return json({ error: "Rate limit exceeded. Try again later." }, 429, origin, env);
      }

      
if (url.pathname === "/api/check" && request.method === "POST") {
    if (!(await enforceRateLimit(request, env))) {
        return json({ error: "Rate limit exceeded. Try again later." }, 429, origin, env);
    }

    const body = await readJson(request);

    if (typeof body.url !== "string") {
        return json({ error: "A website URL is required." }, 400, origin, env);
    }

    return json(await checkUrl(body.url), 200, origin, env);
}

    

      if (url.pathname === "/api/monitors" && request.method === "POST") {
        const body = await readJson(request);
        const target = validatePublicUrl(body.url);
        if (await getMonitorCount(env) >= MAX_MONITORS) return json({ error: `A maximum of ${MAX_MONITORS} monitors is allowed.` }, 409, origin, env);
        const id = crypto.randomUUID();
        const monitor = {
          id,
          url: target.href,
          name: String(body.name || target.hostname).trim().slice(0, 80) || target.hostname,
          createdAt: new Date().toISOString(),
          enabled: true,
        };
        await env.MONITORS.put(`monitor:${id}`, JSON.stringify(monitor));
        return json({ monitor }, 201, origin, env);
      }

      if (url.pathname.startsWith("/api/monitors/") && request.method === "DELETE") {
        const id = url.pathname.split("/").pop();
        if (!validMonitorId(id)) return json({ error: "Invalid monitor id." }, 400, origin, env);
        const monitor = await getMonitor(env, id);
        if (!monitor) return json({ error: "Monitor not found." }, 404, origin, env);
        await env.MONITORS.delete(`monitor:${id}`);
        await env.MONITORS.delete(`history:${id}`);
        return json({ deleted: true }, 200, origin, env);
      }

      return json({ error: "Not found." }, 404, origin, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error.";
      return json({ error: message }, 400, origin, env);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledChecks(env));
  },
};

async function runScheduledChecks(env) {
  const listed = await env.MONITORS.list({ prefix: "monitor:", limit: MAX_MONITORS });
  for (const key of listed.keys) {
    try {
      const id = key.name.slice("monitor:".length);
      const monitor = await getMonitor(env, id);
      if (!monitor || !monitor.enabled) continue;
      const result = await checkUrl(monitor.url);
      await saveCheck(env, monitor, result);
    } catch (error) {
      // Continue checking other monitors if one stored monitor is malformed or fails.
      // Errors are intentionally not returned to public clients from the scheduled event.
    }
  }
}
