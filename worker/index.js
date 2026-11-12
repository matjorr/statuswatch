const corsHeaders = (origin, env) => {
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim());
  const allowOrigin = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : "null");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
};

function json(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin, env) }
  });
}

function validatePublicUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error("Enter a valid URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS websites are supported.");
  if (url.username || url.password) throw new Error("URLs containing usernames or passwords are not allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Private and local network addresses cannot be checked.");
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    throw new Error("Enter a public domain name rather than an IP address.");
  }
  if (!host.includes(".") || host.length > 253) throw new Error("Enter a fully qualified public domain name.");
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
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "StatusWatch-Monitor/1.0", "Range": "bytes=0-0" }
      });
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error: error.name === "AbortError" ? "Request timed out." : "The website could not be reached." };
    }
    const latencyMs = Date.now() - started;
    return {
      ok: response.status >= 200 && response.status < 500,
      httpStatus: response.status,
      latencyMs,
      checkedAt: new Date().toISOString(),
      finalUrl: response.url
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, service: "StatusWatch API", time: new Date().toISOString() }, 200, origin, env);
      }
      if (url.pathname === "/api/check" && request.method === "POST") {
        const body = await request.json();
        if (typeof body.url !== "string") return json({ error: "A website URL is required." }, 400, origin, env);
        const result = await checkUrl(body.url);
        return json(result, 200, origin, env);
      }
      if (url.pathname === "/api/monitors" && request.method === "GET") {
        const list = await env.MONITORS.list({ prefix: "monitor:" });
        const items = await Promise.all(list.keys.map(async key => {
          const monitor = JSON.parse(await env.MONITORS.get(key.name));
          const history = JSON.parse(await env.MONITORS.get(`history:${monitor.id}`) || "[]");
          return { ...monitor, latest: history.length ? history[history.length - 1] : null };
        }));
        return json({ monitors: items }, 200, origin, env);
      }
      if (url.pathname === "/api/monitors" && request.method === "POST") {
        const body = await request.json();
        const target = validatePublicUrl(body.url);
        const id = crypto.randomUUID();
        const monitor = { id, url: target.href, name: String(body.name || target.hostname).slice(0, 80), createdAt: new Date().toISOString(), enabled: true };
        await env.MONITORS.put(`monitor:${id}`, JSON.stringify(monitor));
        return json({ monitor }, 201, origin, env);
      }
      if (url.pathname.startsWith("/api/monitors/") && request.method === "DELETE") {
        const id = url.pathname.split("/").pop();
        await env.MONITORS.delete(`monitor:${id}`);
        return json({ deleted: true }, 200, origin, env);
      }
      if (url.pathname === "/api/history" && request.method === "GET") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "Monitor id is required." }, 400, origin, env);
        const raw = await env.MONITORS.get(`history:${id}`);
        return json({ history: raw ? JSON.parse(raw) : [] }, 200, origin, env);
      }
      return json({ error: "Not found." }, 404, origin, env);
    } catch (error) {
      return json({ error: error.message || "Unexpected server error." }, 400, origin, env);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledChecks(env));
  }
};

async function runScheduledChecks(env) {
  const listed = await env.MONITORS.list({ prefix: "monitor:" });
  for (const key of listed.keys) {
    const raw = await env.MONITORS.get(key.name);
    if (!raw) continue;
    const monitor = JSON.parse(raw);
    if (!monitor.enabled) continue;
    const result = await checkUrl(monitor.url);
    const historyKey = `history:${monitor.id}`;
    const history = JSON.parse(await env.MONITORS.get(historyKey) || "[]");
    history.push({ checkedAt: new Date().toISOString(), ...result });
    await env.MONITORS.put(historyKey, JSON.stringify(history.slice(-2016)));
  }
}
