# HK Climate

An interactive dashboard of daily, monthly and annual air temperatures at the
Hong Kong Observatory — with a reference period you can drag, warming stripes,
a temperature heatmap and a very-hot-days trend.

It runs as a single **Cloudflare Worker**: the Worker serves the static
front-end, rebuilds a compact JSON dataset from the Hong Kong Observatory (HKO)
on a daily **Cron Trigger**, and stores it in **KV**. Charts are rendered in the
browser, so nothing is computed at request time.

## Architecture

```
src/hko.js       fetch + merge + aggregate HKO data (Open Data API + Daily Extract)
src/index.js     Worker: cron handler, GET /api/temps, POST /api/refresh, static assets
site/            front-end (plain HTML/CSS/JS)
site/vendor/     vendored d3 (ISC) and Observable Plot (ISC) for offline rendering
test/            unit tests (node --test)
wrangler.toml    assets + cron + KV bindings
```

### Data sources

* **Open Data API** — `data.weather.gov.hk/.../opendata.php` with
  `dataType=CLMTEMP|CLMMAXT|CLMMINT` for the full mean/max/min history.
* **Daily Extract** — `hko.gov.hk/cis/dailyExtract/dailyExtract_<YYYY>.xml`
  (completed months + extras) and `dailyExtract_<YYYYMM>.xml` (current
  month-to-date). Despite the `.xml` extension these endpoints return JSON.

The two sources agree numerically; the Daily Extract just publishes the current
month earlier. The current month is therefore month-to-date. Charts compare a
part-year or part-month with the same part of the reference period, so a year
still in progress is not measured against full reference years.

## Local development

Requires Node ≥ 20 and pnpm.

```bash
pnpm install
pnpm dev            # http://localhost:8787
pnpm seed           # first run only: populate KV via POST /api/refresh
```

`wrangler dev` simulates KV locally under `.wrangler/state` (gitignored), so the
seed survives restarts. Editing `site/` and refreshing the browser is enough to
iterate on the UI — the vendored libraries mean the front-end needs no network.

To exercise the cron handler itself:

```bash
pnpm dev:cron
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

Other scripts:

| Script | Purpose |
| --- | --- |
| `pnpm test` | Run the unit tests (`node --test`) |
| `pnpm check` | Syntax-check the Worker and front-end |
| `pnpm build:dry` | Validate the Worker bundle without deploying |
| `pnpm kv:create` | Create the production `TEMPS` KV namespace |

## Deploying to Cloudflare

1. **Create the KV namespace** and copy its id:

   ```bash
   pnpm kv:create
   ```

2. **Provide the id to Wrangler.** Either paste it into `wrangler.toml`
   (replacing `REPLACE_WITH_KV_NAMESPACE_ID`), or leave the placeholder and set a
   `KV_NAMESPACE_ID` repository variable — the deploy workflow injects it at
   deploy time.

3. **Deploy:**

   ```bash
   pnpm deploy
   ```

   The cron trigger (`0 22 * * *` = 06:00 HKT) then keeps the dataset current.
   Until it first runs, the API returns `503`; trigger a build with
   `POST /api/refresh` (see below).

### Continuous deployment

`.github/workflows/deploy.yml` deploys on every push to `main` (and on manual
dispatch) with `pnpm exec wrangler deploy`. The workflows use only GitHub-owned
actions, each pinned to a full commit SHA (this repository requires SHA
pinning), plus a small shell step to install the pnpm version from
`packageManager`. All deployment values live on a GitHub **`production`
environment** (Settings → Environments), so they are only exposed to the
`Deploy` and `Refresh data` jobs:

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | API token with *Workers Scripts: Edit* and *Workers KV Storage: Edit* |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Your Cloudflare account id |
| `REFRESH_TOKEN` | secret | Any long random string (guards `/api/refresh`) |
| `KV_NAMESPACE_ID` | variable | The `TEMPS` namespace id (from `pnpm kv:create`) |
| `SITE_URL` | variable | Public Worker URL, e.g. `https://hk-climate.<subdomain>.workers.dev` |

After deploying, the workflow pushes `REFRESH_TOKEN` to the Worker as a secret
and calls `POST /api/refresh` so the KV cache is warm immediately. The
`Refresh data` workflow does the same on demand. Requests from localhost are
always allowed; elsewhere the route requires
`Authorization: Bearer <REFRESH_TOKEN>`.

## Updating vendored libraries

`site/vendor/` is committed on purpose so the site renders offline. d3 and
Observable Plot are not tracked by Dependabot; bump them by hand and re-commit
the minified files.

## License

[AGPL-3.0-or-later](LICENSE). Vendored d3 and Observable Plot are ISC licensed.
HKO data is public; see the Observatory's terms of use.
