// Front-end: fetch the precomputed dataset and draw it with Observable Plot.
// Each chart renders at its container's real pixel width so it fills the card,
// and re-renders on resize (ResizeObserver) or when controls change.

import { computeReference, mean } from "./reference.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const BASE = Date.UTC(2000, 0, 1);
const DAY = 86400000;
const doyDate = (doy) => new Date(BASE + (doy - 1) * DAY);

const el = (id) => document.getElementById(id);

const state = {
  data: null,
  minYear: 1884,
  maxYear: 2026,
  fromYear: 1980,
  metric: "mean",
  showRange: true,
  refStart: 1991,
  refEnd: 2020,
  clim: null,
  heatmapStart: 1,
  heatmapEnd: 12,
};

function linearTrend(xs, ys) {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx };
}

function yearsInRange() {
  return Object.keys(state.data.years)
    .map(Number)
    .filter((y) => y >= state.fromYear)
    .sort((a, b) => a - b);
}

// Decade tick values inside [start, end] — used to thin crowded year axes.
function decadeTicks(start, end) {
  const ticks = [];
  for (let y = Math.ceil(start / 10) * 10; y <= end; y += 10) ticks.push(y);
  return ticks;
}

// --- responsive chart plumbing -------------------------------------------- //

const charts = {};
const lastWidth = {};

function chartWidth(id) {
  const node = el("chart-" + id);
  const cs = getComputedStyle(node);
  const w = node.clientWidth
    - parseFloat(cs.paddingLeft || "0")
    - parseFloat(cs.paddingRight || "0");
  return Math.max(300, Math.round(w || 640));
}

function draw(id) {
  const node = el("chart-" + id);
  if (!node || node.clientWidth === 0) return; // hidden tab
  const w = chartWidth(id);
  lastWidth[id] = w;
  node.replaceChildren(charts[id](w));
}

function watch(id) {
  let raf = 0;
  const ro = new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (Math.abs(w - (lastWidth[id] ?? 0)) < 2) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => draw(id));
  });
  ro.observe(el("chart-" + id));
}

// --- charts ---------------------------------------------------------------- //

charts.current = (width) => {
  const { data, clim } = state;
  const cur = data.years[state.maxYear];
  if (!cur) return Plot.plot({ width, height: 120 });

  const normal = [];
  for (let i = 0; i < 366; i += 1) {
    const m = clim.mean[i];
    const s = clim.std[i];
    if (m == null || s == null) continue;
    normal.push({
      date: doyDate(i + 1), mean: m,
      lo1: m - s, hi1: m + s, lo2: m - 2 * s, hi2: m + 2 * s,
    });
  }

  const points = [];
  for (let i = 0; i < 366; i += 1) {
    const m = cur.mean[i];
    if (m == null) continue;
    points.push({ date: doyDate(i + 1), mean: m, max: cur.max[i], min: cur.min[i] });
  }

  const marks = [
    Plot.areaY(normal, { x: "date", y1: "lo2", y2: "hi2", fill: "#9aa5b1", fillOpacity: 0.15 }),
    Plot.areaY(normal, { x: "date", y1: "lo1", y2: "hi1", fill: "#9aa5b1", fillOpacity: 0.28 }),
    Plot.lineY(normal, { x: "date", y: "mean", stroke: "#333", strokeWidth: 1 }),
  ];
  if (state.showRange) {
    marks.push(Plot.areaY(points, { x: "date", y1: "min", y2: "max", fill: "coral", fillOpacity: 0.18 }));
  }
  marks.push(Plot.lineY(points, { x: "date", y: "mean", stroke: "crimson", strokeWidth: 2.2, tip: true }));

  return Plot.plot({
    width,
    height: 380,
    marginLeft: 55,
    marginRight: 20,
    x: { label: null },
    y: { label: "Temperature (°C)", grid: true },
    marks,
  });
};

charts.overlay = (width) => {
  const { data, metric } = state;
  const years = yearsInRange();
  const points = [];
  for (const y of years) {
    const arr = data.years[y][metric] ?? [];
    for (let i = 0; i < arr.length; i += 1) {
      if (arr[i] != null) points.push({ date: doyDate(i + 1), value: arr[i], year: y });
    }
  }
  const latest = years.at(-1);

  return Plot.plot({
    width,
    height: 420,
    marginLeft: 55,
    marginRight: 30,
    x: { label: null },
    y: { label: `Daily ${metric} temperature (°C)`, grid: true },
    color: { scheme: "viridis", legend: true, label: "Year" },
    marks: [
      Plot.lineY(points, {
        x: "date", y: "value", z: "year", stroke: "year",
        strokeWidth: (d) => (d.year === latest ? 2.2 : 0.7),
        strokeOpacity: (d) => (d.year === latest ? 1 : 0.35),
      }),
    ],
  });
};

charts.heatmap = (width) => {
  const { data, metric, heatmapStart, heatmapEnd } = state;
  const ys = yearsInRange();
  const cells = [];

  // Temperature is not an anomaly, so map it linearly across the tightest
  // multiples of 5 that cover the values shown. A diverging scheme would put
  // the pivot (0) in the middle of the ramp, so force type:"linear" to treat
  // RdYlBu as a plain sequential interpolator. Compute the extent over all
  // months so the colours stay stable while the month slider moves.
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const y of ys) {
    const arr = data.years[y][metric] ?? [];
    for (let i = 0; i < arr.length; i += 1) {
      const v = arr[i];
      if (v == null) continue;
      if (v < vmin) vmin = v;
      if (v > vmax) vmax = v;
      const d = doyDate(i + 1);
      const month = d.getUTCMonth() + 1;
      if (month < heatmapStart || month > heatmapEnd) continue;
      cells.push({ year: y, date: d, value: v });
    }
  }
  let lo = Math.floor(vmin / 5) * 5;
  let hi = Math.ceil(vmax / 5) * 5;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    lo = 0;
    hi = 5;
  }

  return Plot.plot({
    width,
    height: Math.max(340, Math.min(900, ys.length * 9)),
    marginLeft: 55,
    marginRight: 20,
    x: {
      label: null,
      type: "band",
      tickFormat: (d) => (d.getUTCDate() === 1 ? MONTHS[d.getUTCMonth()] : ""),
    },
    y: {
      label: null,
      type: "band",
      ticks: decadeTicks(ys[0], ys.at(-1)),
      tickFormat: (v) => String(v),
    },
    color: { type: "linear", scheme: "RdYlBu", reverse: true, domain: [lo, hi], legend: true, label: "°C" },
    marks: [
      Plot.cell(cells, { x: "date", y: "year", fill: "value", inset: 0, tip: true }),
    ],
  });
};

charts.stripes = (width) => {
  const { data } = state;
  const years = yearsInRange().filter((y) => data.annual[y] != null);
  const base = state.clim?.annualMean ?? mean(years.map((y) => data.annual[y]));
  const currentBase = state.clim?.partialAnnualMean ?? base;
  const stripes = years.map((y) => ({
    year: y,
    anomaly: data.annual[y] - (y === state.maxYear ? currentBase : base),
  }));

  return Plot.plot({
    width,
    height: 150,
    marginLeft: 55,
    marginRight: 20,
    x: { label: null, ticks: decadeTicks(years[0], years.at(-1)) },
    y: { axis: null, domain: [0, 1] },
    color: { scheme: "RdBu", reverse: true, domain: [-2.5, 2.5], legend: true, label: "Anomaly (°C)" },
    marks: [
      Plot.rect(stripes, {
        x1: "year", x2: (d) => d.year + 1, y1: 0, y2: 1, fill: "anomaly",
        title: (d) => `${d.year}: ${d.anomaly >= 0 ? "+" : ""}${d.anomaly.toFixed(2)} °C`,
      }),
    ],
  });
};

charts.hot = (width) => {
  const { data } = state;
  const years = yearsInRange().filter((y) => data.hotDays[y] != null);
  const hot = years.map((y) => ({ year: y, count: data.hotDays[y] }));
  const { slope, intercept } = linearTrend(years, hot.map((d) => d.count));
  const trend = years.map((y) => ({ year: y, count: intercept + slope * y }));

  return Plot.plot({
    width,
    height: 340,
    marginLeft: 55,
    marginRight: 20,
    x: {
      label: "Year",
      type: "band",
      ticks: decadeTicks(years[0], years.at(-1)),
      tickFormat: (v) => String(v),
    },
    y: { label: "Days with max ≥ 30 °C", grid: true },
    color: { scheme: "viridis", legend: true, label: "Year" },
    marks: [
      Plot.barY(hot, { x: "year", y: "count", fill: "year", tip: true }),
      Plot.lineY(trend, { x: "year", y: "count", stroke: "crimson", strokeWidth: 2, strokeDasharray: "5,4" }),
    ],
  });
};

charts.monthly = (width) => {
  const { data } = state;
  const ys = yearsInRange();
  const cells = [];
  const period = state.clim.period;
  for (const y of ys) {
    const vals = data.monthly.values[y] ?? [];
    for (let m = 0; m < 12; m += 1) {
      const partMonth = y === state.maxYear && period && m + 1 === period.month;
      const normal = partMonth
        ? state.clim.partialMonthlyNormal[m]
        : state.clim.monthlyNormal[m];
      if (vals[m] != null && normal != null) {
        cells.push({ month: m + 1, year: y, anomaly: vals[m] - normal });
      }
    }
  }

  return Plot.plot({
    width,
    height: 460,
    marginLeft: 55,
    marginRight: 20,
    x: { label: null, type: "band", tickFormat: (m) => MONTHS[m - 1] },
    y: {
      label: null,
      type: "band",
      ticks: decadeTicks(ys[0], ys.at(-1)),
      tickFormat: (v) => String(v),
    },
    color: { scheme: "RdBu", reverse: true, domain: [-3, 3], legend: true, label: "Anomaly (°C)" },
    marks: [
      Plot.cell(cells, { x: "month", y: "year", fill: "anomaly", inset: 0, tip: true }),
    ],
  });
};

// --- controls -------------------------------------------------------------- //

function updateRefText() {
  el("current-title").textContent =
    `Latest year vs the ${state.refStart}–${state.refEnd} normal`;
  el("monthly-title").textContent =
    `Monthly temperature anomaly vs ${state.refStart}–${state.refEnd}`;
  el("ref-note").innerHTML =
    `Normals and anomalies use <strong>${state.refStart}–${state.refEnd}</strong>.`;
}

function updateRefFill() {
  const lo = state.minYear;
  const hi = state.maxYear;
  const span = Math.max(1, hi - lo);
  const a = Number(el("ref-start").value);
  const b = Number(el("ref-end").value);
  const left = ((a - lo) / span) * 100;
  const right = ((b - lo) / span) * 100;
  const fill = el("ref-fill");
  fill.style.left = `${left}%`;
  fill.style.width = `${Math.max(0, right - left)}%`;
}

function updateHeatmapFill() {
  const span = 11;
  const a = Number(el("hm-start").value);
  const b = Number(el("hm-end").value);
  const left = ((a - 1) / span) * 100;
  const right = ((b - 1) / span) * 100;
  const fill = el("hm-fill");
  fill.style.left = `${left}%`;
  fill.style.width = `${Math.max(0, right - left)}%`;
}

function clampYear(v) {
  return Math.max(state.minYear, Math.min(state.maxYear, Math.round(Number(v))));
}

function applyReference(start, end) {
  let s = clampYear(start);
  let e = clampYear(end);
  if (s > e) [s, e] = [e, s];

  state.refStart = s;
  state.refEnd = e;
  state.clim = computeReference(state.data, s, e);

  el("ref-start").value = String(s);
  el("ref-end").value = String(e);
  el("ref-out").textContent = `${s}–${e}`;
  updateRefFill();
  updateRefText();
  ["current", "stripes", "monthly"].forEach(draw);
}

let refTimer = 0;
function scheduleReference() {
  clearTimeout(refTimer);
  refTimer = setTimeout(
    () => applyReference(el("ref-start").value, el("ref-end").value),
    150,
  );
}

function onRefInput(which) {
  let a = Number(el("ref-start").value);
  let b = Number(el("ref-end").value);
  if (which === "start" && a > b) { a = b; el("ref-start").value = String(a); }
  if (which === "end" && b < a) { b = a; el("ref-end").value = String(b); }
  el("ref-out").textContent = `${a}–${b}`;
  updateRefFill();
  scheduleReference();
}

let hmTimer = 0;
function scheduleHeatmap() {
  clearTimeout(hmTimer);
  hmTimer = setTimeout(() => draw("heatmap"), 120);
}

function onHeatmapInput(which) {
  let a = Number(el("hm-start").value);
  let b = Number(el("hm-end").value);
  if (which === "start" && a > b) { a = b; el("hm-start").value = String(a); }
  if (which === "end" && b < a) { b = a; el("hm-end").value = String(b); }
  state.heatmapStart = a;
  state.heatmapEnd = b;
  el("hm-out").textContent = a === b ? MONTHS[a - 1] : `${MONTHS[a - 1]}–${MONTHS[b - 1]}`;
  updateHeatmapFill();
  scheduleHeatmap();
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.hidden = p.id !== `panel-${name}`;
  });
  requestAnimationFrame(() => {
    document.querySelectorAll(".tab-panel:not([hidden]) .chart").forEach((node) => {
      const id = node.id.replace("chart-", "");
      if (charts[id]) draw(id);
    });
  });
}

function wireTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      activateTab(name);
      history.replaceState(null, "", `#${name}`);
    });
  });
  activateTab(location.hash === "#years" ? "years" : "summary");
}

function wireControls() {
  el("from-year").addEventListener("input", (e) => {
    state.fromYear = Number(e.target.value);
    el("from-year-out").textContent = String(state.fromYear);
    ["overlay", "heatmap", "stripes", "hot", "monthly"].forEach(draw);
  });

  el("metric").addEventListener("change", (e) => {
    state.metric = e.target.value;
    ["overlay", "heatmap"].forEach(draw);
  });

  el("show-range").addEventListener("change", (e) => {
    state.showRange = e.target.checked;
    draw("current");
  });

  el("refresh").addEventListener("click", async () => {
    el("refresh").disabled = true;
    await fetch("/api/refresh");
    window.location.reload();
  });

  el("ref-start").addEventListener("input", () => onRefInput("start"));
  el("ref-end").addEventListener("input", () => onRefInput("end"));
  el("hm-start").addEventListener("input", () => onHeatmapInput("start"));
  el("hm-end").addEventListener("input", () => onHeatmapInput("end"));
}

// --- bootstrap ------------------------------------------------------------- //

async function main() {
  try {
    const resp = await fetch("/api/temps");
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${resp.status}`);
    }
    state.data = await resp.json();

    const meta = state.data.meta;
    const ys = Object.keys(state.data.years).map(Number);
    state.minYear = Math.min(...ys);
    state.maxYear = Math.max(...ys);

    for (const id of ["ref-start", "ref-end", "from-year"]) {
      el(id).min = String(state.minYear);
      el(id).max = String(state.maxYear);
    }
    el("from-year").value = String(Math.max(state.minYear, state.maxYear - 45));
    state.fromYear = Number(el("from-year").value);
    el("from-year-out").textContent = String(state.fromYear);

    el("meta").textContent =
      `Latest observation ${meta.latest} · ${ys.length} years · ` +
      `built ${meta.generated.slice(0, 16).replace("T", " ")} UTC`;

    state.refStart = 1991;
    state.refEnd = 2020;
    state.clim = computeReference(state.data, 1991, 2020);
    el("ref-start").value = "1991";
    el("ref-end").value = "2020";

    wireControls();
    wireTabs();                       // draws the visible tab's charts
    for (const id of Object.keys(charts)) watch(id);

    updateRefFill();
    el("ref-out").textContent = "1991–2020";
    updateHeatmapFill();
    el("hm-out").textContent = "Jan–Dec";
    updateRefText();

    if (["localhost", "127.0.0.1"].includes(window.location.hostname)) {
      el("refresh").hidden = false;
    }
  } catch (err) {
    el("error").hidden = false;
    el("error").textContent = `Could not load data: ${err.message}`;
  }
}

main();
