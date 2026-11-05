import test from "node:test";
import assert from "node:assert/strict";

import { computeReference, observedPeriod } from "../site/reference.js";

const close = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-12,
    `expected ${actual} to be close to ${expected}`,
  );

function yearSeries(year, valueForDate) {
  const mean = new Array(366).fill(null);
  for (let i = 0; i < 366; i += 1) {
    const date = new Date(Date.UTC(year, 0, i + 1));
    if (date.getUTCFullYear() !== year) continue;
    mean[i] = valueForDate(date);
  }
  return { mean };
}

test("observedPeriod parses the latest observation date", () => {
  assert.deepEqual(observedPeriod({ meta: { latest: "2026-03-02" } }), {
    year: 2026,
    month: 3,
    day: 2,
  });
  assert.equal(observedPeriod({ meta: { latest: null } }), null);
  assert.equal(observedPeriod({}), null);
});

test("partial reference means use the same calendar window as the current year", () => {
  // January and February are 0, March days are their day number, the rest 100.
  const data = {
    meta: { latest: "2026-03-02" },
    years: {
      1991: yearSeries(1991, (date) => {
        const month = date.getUTCMonth() + 1;
        if (month <= 2) return 0;
        if (month === 3) return date.getUTCDate();
        return 100;
      }),
    },
  };

  const ref = computeReference(data, 1991, 1991);

  assert.deepEqual(ref.period, { year: 2026, month: 3, day: 2 });
  // 31 January + 28 February + 2 March days = 61 days, summing to 1 + 2.
  close(ref.partialAnnualMean, 3 / 61);
  // March 1 and 2 only: (1 + 2) / 2.
  close(ref.partialMonthlyNormal[2], 1.5);
  // Full March normal is still the mean of every March day.
  close(ref.monthlyNormal[2], 16);
});

test("partial reference means include 29 February in leap reference years", () => {
  const data = {
    meta: { latest: "2024-02-29" },
    years: {
      2020: yearSeries(2020, (date) =>
        date.getUTCMonth() === 1 && date.getUTCDate() === 29 ? 5 : 0,
      ),
    },
  };

  const ref = computeReference(data, 2020, 2020);

  // 31 January + 29 February days = 60 days.
  close(ref.partialAnnualMean, 5 / 60);
  close(ref.partialMonthlyNormal[1], 5 / 29);
});

test("computeReference leaves partial means null without a latest date", () => {
  const data = {
    meta: { latest: null },
    years: {
      1991: yearSeries(1991, () => 20),
    },
    annual: { 1991: 20 },
  };

  const ref = computeReference(data, 1991, 1991);

  assert.equal(ref.period, null);
  assert.equal(ref.partialAnnualMean, null);
  assert.deepEqual(ref.partialMonthlyNormal, new Array(12).fill(null));
  close(ref.annualMean, 20);
});
