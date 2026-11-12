# StatusWatch

A responsive website uptime dashboard with a Cloudflare Worker API.

## Architecture

- **Frontend:** static HTML, CSS and JavaScript hosted on GitHub Pages.
- **API:** Cloudflare Worker (`worker/index.js`) performs server-side checks.
- **Storage and schedule:** Cloudflare KV stores saved monitors and recent check history; a Cron Trigger checks monitors every five minutes.

GitHub Pages cannot run a backend or scheduled monitoring process. The Worker is required for real server-side checks and automatic monitoring.

## 1. Publish the frontend on GitHub Pages

1. Create a GitHub repository named `statuswatch` (or another name).
2. Upload the root files and `.github/workflows/deploy.yml` to the repository.
3. In GitHub, open **Settings → Pages** and set the build/deployment source to **GitHub Actions**.
4. Push to the `main` branch. The workflow publishes the site.
5. Your site URL will look like `https://YOUR-GITHUB-USERNAME.github.io/statuswatch/`.

## 2. Deploy the monitoring API

You need a free Cloudflare account.

1. Install Node.js, then install Wrangler: `npm install -g wrangler`.
2. Sign in: `wrangler login`.
3. From the `worker` directory, create a KV namespace: `wrangler kv namespace create MONITORS`.
4. Copy the returned namespace ID into `worker/wrangler.toml`, replacing `REPLACE_WITH_YOUR_CLOUDFLARE_KV_NAMESPACE_ID`.
5. Set `ALLOWED_ORIGIN` in `worker/wrangler.toml` to your exact GitHub Pages origin. For a project site, the origin is still `https://YOUR-GITHUB-USERNAME.github.io` (no path).
6. From the `worker` directory, deploy: `wrangler deploy`.
7. Copy the Worker URL, usually `https://statuswatch-api.YOUR-SUBDOMAIN.workers.dev`.

## 3. Connect the frontend to the API

Edit `config.js`:

```js
window.STATUSWATCH_CONFIG = {
  API_BASE_URL: "https://statuswatch-api.YOUR-SUBDOMAIN.workers.dev"
};
```

Commit and push the change. Reload your GitHub Pages site. The **Check status** button now calls your Worker.

## 4. Enable scheduled monitors

The Worker is configured with a five-minute Cron Trigger. The dashboard saves monitors to Cloudflare KV when the API is configured. The Worker checks them every five minutes and stores up to 2,016 recent results per monitor (about seven days). The dashboard loads saved monitors from the API and supports adding, checking, and removing them.

## API endpoints

- `GET /api/health` — API health.
- `POST /api/check` — body: `{"url":"https://example.com"}`.
- `GET /api/monitors` — list saved server-side monitors.
- `POST /api/monitors` — body: `{"url":"https://example.com","name":"Example"}`.
- `DELETE /api/monitors/:id` — delete a monitor.
- `GET /api/history?id=MONITOR_ID` — recent check history.

## Important limitations and security notes

- A successful check means the Worker received an HTTP response in the accepted range. It does not prove the service is healthy for every visitor or region.
- Some sites block automated requests, require JavaScript, or rate-limit checks. Those can appear unavailable even while working in a normal browser.
- The initial implementation uses one Cloudflare region and is not a multi-region synthetic monitoring service.
- Public domain validation rejects obvious local hostnames and literal IP addresses. Before offering unrestricted public URL monitoring at scale, add stronger SSRF protections, rate limits, abuse controls, and DNS/IP validation at connection time.
- The first frontend release stores its watchlist in browser local storage. Server-side scheduled monitoring is available through the API, but the dashboard still needs the next integration step to create/manage remote monitors and visualize their history.
- Do not describe the sample dashboard counters as global uptime statistics. They are local session metrics.

## Local preview

Run a static server from the project root, for example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.
