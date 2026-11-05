// Build the compact temperature dataset used by the web front-end.
//
// This mirrors `data_sources.py`:
//   1. HKO Open Data API (CLMTEMP/CLMMAXT/CLMMINT)  -> full history of mean/max/min
//   2. Daily Extract yearly file  (dailyExtract_<YYYY>.xml) -> completed months + extras
//   3. Daily Extract monthly file (dailyExtract_<YYYYMM>.xml) -> current month-to-date
//
// The mean/max/min values are identical between (1) and (2/3); the Daily Extract
// simply publishes the current month earlier. See ../README.md.

const API = "https://data.weather.gov.hk/weatherAPI/opendata/opendata.php";
const DX_YEAR = (y) => `https://www.hko.gov.hk/cis/dailyExtract/dailyExtract_${y}.xml`;
const DX_MONTH = (y, m) =>
  `https://www.hko.gov.hk/cis/dailyExtract/dailyExtract_${y}${String(m).padStart(2, "0")}.xml`;

const REF_START = 1991;
const REF_END = 2020;
const HOT_THRESHOLD = 30;
const DEFAULT_EXTRA_YEARS = 10;

async function getJSON(url) {
  const resp = await fetch(url, { headers: { "user-agent": "hk-temperatures-worker" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return JSON.parse(await resp.text());
}

export function num(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === "" || s === "***" || s === "*") return null;
  if (s === "Trace") return 0;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

const pad = (n) => String(n).padStart(2, "0");

async function fetchApiSeries(dataType) {
  const payload = await getJSON(`${API}?dataType=${dataType}&rformat=json&station=HKO`);
  const map = new Map();
  for (const row of payload.data ?? []) {
    const [y, m, d, v] = row;
    const value = num(v);
    if (value != null) map.set(`${y}-${pad(m)}-${pad(d)}`, value);
  }
  return map;
}

export function parseDailyExtract(payload, year) {
  const records = [];
  for (const block of payload?.stn?.data ?? []) {
    const month = Number(block.month);
    for (const row of block.dayData ?? []) {
      if (!/^\d+$/.test(String(row[0]).trim())) continue; // skip Mean/Normal rows
      records.push({
        year,
        month,
        day: Number(row[0]),
        temp_max: num(row[2]),
        temp_mean: num(row[3]),
        temp_min: num(row[4]),
        humidity: num(row[6]),
        rainfall: num(row[8]),
      });
    }
  }
  return records;
}

export function dayOfYear(year, month, day) {
  const ms = Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1);
  return Math.round(ms / 86400000) + 1;
}

export function mean(values) {
  let sum = 0;
  let n = 0;
  for (const v of values) if (v != null) { sum += v; n += 1; }
  return n ? sum / n : null;
}

export function std(values, m) {
  let sum = 0;
  let n = 0;
  for (const v of values) if (v != null) { sum += (v - m) ** 2; n += 1; }
  return n ? Math.sqrt(sum / n) : null;
}

/** Fetch, merge and aggregate everything the front-end needs. */
export async function buildDataset(now = new Date(), extraYears = DEFAULT_EXTRA_YEARS) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const [meanMap, maxMap, minMap] = await Promise.all([
    fetchApiSeries("CLMTEMP"),
    fetchApiSeries("CLMMAXT"),
    fetchApiSeries("CLMMINT"),
  ]);

  // Recent Daily Extract: a few years of extras + the current month-to-date.
  const years = [];
  for (let y = year - extraYears; y <= year; y += 1) years.push(y);
  const dxResponses = await Promise.all([
    ...years.map((y) => getJSON(DX_YEAR(y)).catch(() => null)),
    getJSON(DX_MONTH(year, month)).catch(() => null),
  ]);
  const extras = [];
  years.forEach((y, i) => {
    if (dxResponses[i]) extras.push(...parseDailyExtract(dxResponses[i], y));
  });
  const last = dxResponses[years.length];
  if (last) extras.push(...parseDailyExtract(last, year));

  // Merge everything on the ISO date.
  const records = new Map();
  const ensure = (key) => {
    let r = records.get(key);
    if (!r) {
      const [y, m, d] = key.split("-").map(Number);
      r = { date: key, year: y, month: m, day: d, doy: dayOfYear(y, m, d),
            mean: null, max: null, min: null, rainfall: null };
      records.set(key, r);
    }
    return r;
  };
  for (const [key, v] of meanMap) ensure(key).mean = v;
  for (const [key, v] of maxMap) ensure(key).max = v;
  for (const [key, v] of minMap) ensure(key).min = v;
  for (const r of extras) {
    const rec = ensure(`${r.year}-${pad(r.month)}-${pad(r.day)}`);
    if (r.temp_mean != null) rec.mean = r.temp_mean;
    if (r.temp_max != null) rec.max = r.temp_max;
    if (r.temp_min != null) rec.min = r.temp_min;
    if (r.rainfall != null) rec.rainfall = r.rainfall;
  }

  const all = [...records.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  // Per-year arrays indexed by (doy - 1).
  const byYear = {};
  for (const r of all) {
    const slot = (byYear[r.year] ??= { mean: [], max: [], min: [] });
    slot.mean[r.doy - 1] = r.mean;
    slot.max[r.doy - 1] = r.max;
    slot.min[r.doy - 1] = r.min;
  }
  const yearList = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const dense = {};
  for (const y of yearList) {
    const slot = byYear[y];
    const fill = (a) => Array.from({ length: 366 }, (_, i) => a?.[i] ?? null);
    dense[y] = { mean: fill(slot.mean), max: fill(slot.max), min: fill(slot.min) };
  }

  // Climatology per day-of-year over the reference period.
  const climMean = [];
  const climStd = [];
  for (let doy = 1; doy <= 366; doy += 1) {
    const values = [];
    for (let y = REF_START; y <= REF_END; y += 1) {
      const v = dense[y]?.mean?.[doy - 1];
      if (v != null) values.push(v);
    }
    const m = mean(values);
    climMean.push(m);
    climStd.push(m == null ? null : std(values, m));
  }

  // Monthly means and anomalies, annual means, hot-day counts.
  const monthlyNormal = [];
  for (let m = 0; m < 12; m += 1) {
    const values = [];
    for (let y = REF_START; y <= REF_END; y += 1) {
      for (let doy = 0; doy < 366; doy += 1) {
        const t = dense[y]?.mean?.[doy];
        if (t != null && new Date(Date.UTC(y, 0, doy + 1)).getUTCMonth() === m) values.push(t);
      }
    }
    monthlyNormal.push(mean(values));
  }

  const monthly = {};
  const annual = {};
  const hotDays = {};
  for (const y of yearList) {
    const perMonth = Array.from({ length: 12 }, () => []);
    for (let doy = 0; doy < 366; doy += 1) {
      const t = dense[y].mean[doy];
      if (t == null) continue;
      const m = new Date(Date.UTC(y, 0, doy + 1)).getUTCMonth();
      perMonth[m].push(t);
    }
    monthly[y] = perMonth.map((vals) => mean(vals));
    annual[y] = mean(dense[y].mean);
    hotDays[y] = dense[y].max.filter((v) => v != null && v >= HOT_THRESHOLD).length;
  }

  const latest = all.at(-1)?.date ?? null;
  return {
    meta: {
      station: "HKO",
      generated: new Date().toISOString(),
      latest,
      first: all[0]?.date ?? null,
      reference: [REF_START, REF_END],
      hotThreshold: HOT_THRESHOLD,
    },
    climatology: { mean: climMean, std: climStd },
    years: dense,
    monthly: { normal: monthlyNormal, values: monthly },
    annual,
    hotDays,
  };
}
