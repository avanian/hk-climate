import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDataset,
  dayOfYear,
  mean,
  num,
  parseDailyExtract,
  std,
} from "../src/hko.js";

test("num parses values and sentinels", () => {
  assert.equal(num("12.5"), 12.5);
  assert.equal(num("***"), null);
  assert.equal(num("*"), null);
  assert.equal(num(""), null);
  assert.equal(num("Trace"), 0);
  assert.equal(num(null), null);
  assert.equal(num(7), 7);
});

test("dayOfYear handles leap years", () => {
  assert.equal(dayOfYear(2020, 1, 1), 1);
  assert.equal(dayOfYear(2020, 3, 1), 61); // leap year
  assert.equal(dayOfYear(2021, 3, 1), 60);
  assert.equal(dayOfYear(2020, 12, 31), 366);
});

test("mean and std ignore nulls", () => {
  assert.equal(mean([1, 2, null, 3]), 2);
  assert.equal(mean([]), null);
  assert.equal(std([2, 2, 2], 2), 0);
  assert.ok(Math.abs(std([1, 3], 2) - 1) < 1e-12);
});

test("parseDailyExtract skips summary rows and maps columns", () => {
  const payload = {
    stn: {
      data: [
        {
          month: 11,
          dayData: [
            ["01", "1017.3", "29.5", "27.0", "25.9", "22.4", "76", "66", "0.1"],
            ["Mean/Total", "1017.4", "29.6", "27.3", "25.9", "22.7", "77", "64", "0.7"],
            ["Normal", "1017.5", "24.0", "21.0", "18.0", "15.0", "70", "60", "0.0"],
          ],
        },
      ],
    },
  };

  const records = parseDailyExtract(payload, 2026);

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    year: 2026,
    month: 11,
    day: 1,
    temp_max: 29.5,
    temp_mean: 27.0,
    temp_min: 25.9,
    humidity: 76,
    rainfall: 0.1,
  });
});

test("buildDataset merges API and Daily Extract into the expected shape", async (t) => {
  const routes = [
    ["dataType=CLMTEMP", { data: [[2020, 1, 1, 16.0], [2020, 1, 2, 17.0]] }],
    ["dataType=CLMMAXT", { data: [[2020, 1, 1, 20.0], [2020, 1, 2, 21.0]] }],
    ["dataType=CLMMINT", { data: [[2020, 1, 1, 12.0], [2020, 1, 2, 13.0]] }],
    ["dailyExtract_202001.xml", { stn: { data: [] } }],
    [
      "dailyExtract_2020.xml",
      {
        stn: {
          data: [
            {
              month: 1,
              dayData: [["03", "1017", "20", "18", "14", "12", "70", "50", "0.0"]],
            },
          ],
        },
      },
    ],
  ];

  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const hit = routes.find(([key]) => u.includes(key));
    if (!hit) throw new Error(`unexpected fetch: ${u}`);
    return new Response(JSON.stringify(hit[1]), { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const data = await buildDataset(new Date(Date.UTC(2020, 0, 15)), 0);

  assert.deepEqual(data.meta.reference, [1991, 2020]);
  assert.equal(data.meta.latest, "2020-01-03");
  assert.equal(data.years[2020].mean[0], 16);
  assert.equal(data.years[2020].mean[2], 18);
  assert.equal(data.monthly.values[2020][0], 17);
  assert.equal(data.annual[2020], 17);
  assert.equal(data.hotDays[2020], 0);
  assert.equal(data.climatology.mean.length, 366);
});
