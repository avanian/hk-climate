// Reference-period climatology shared by the dashboard charts.
//
// Part-year and part-month values are compared with the same calendar window
// in each reference year: the annual mean of a current year still in progress
// is not measured against full reference years, and the current month-to-date
// is not measured against full reference months.

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

export function observedPeriod(data) {
  const latest = data?.meta?.latest;
  if (!latest) return null;
  const [year, month, day] = latest.split("-").map(Number);
  if (!year || !month || !day) return null;
  return { year, month, day };
}

// Map a day-of-year slot back to the reference year's own calendar, so
// 29 February stays in February and never shifts later months by a day.
function dateForIndex(year, index) {
  const date = new Date(Date.UTC(year, 0, index + 1));
  return date.getUTCFullYear() === year ? date : null;
}

function withinPartialYear(date, period) {
  const month = date.getUTCMonth() + 1;
  return month < period.month || (month === period.month && date.getUTCDate() <= period.day);
}

export function computeReference(data, start, end) {
  const meanArr = new Array(366).fill(null);
  const stdArr = new Array(366).fill(null);
  for (let i = 0; i < 366; i += 1) {
    const vals = [];
    for (let y = start; y <= end; y += 1) {
      const v = data.years[y]?.mean?.[i];
      if (v != null) vals.push(v);
    }
    if (vals.length) {
      const m = mean(vals);
      meanArr[i] = m;
      stdArr[i] = std(vals, m);
    }
  }

  const monthlyNormal = new Array(12).fill(null);
  for (let mo = 0; mo < 12; mo += 1) {
    const vals = [];
    for (let y = start; y <= end; y += 1) {
      const arr = data.years[y]?.mean;
      if (!arr) continue;
      for (let i = 0; i < 366; i += 1) {
        if (arr[i] == null) continue;
        const date = dateForIndex(y, i);
        if (date && date.getUTCMonth() === mo) vals.push(arr[i]);
      }
    }
    monthlyNormal[mo] = mean(vals);
  }

  const annual = [];
  for (let y = start; y <= end; y += 1) {
    if (data.annual?.[y] != null) annual.push(data.annual[y]);
  }

  const period = observedPeriod(data);
  let partialAnnualMean = null;
  const partialMonthlyNormal = new Array(12).fill(null);
  if (period) {
    const annualValues = [];
    const monthValues = [];
    for (let y = start; y <= end; y += 1) {
      const arr = data.years[y]?.mean;
      if (!arr) continue;
      for (let i = 0; i < 366; i += 1) {
        const v = arr[i];
        if (v == null) continue;
        const date = dateForIndex(y, i);
        if (!date || !withinPartialYear(date, period)) continue;
        annualValues.push(v);
        if (date.getUTCMonth() + 1 === period.month) monthValues.push(v);
      }
    }
    partialAnnualMean = mean(annualValues);
    partialMonthlyNormal[period.month - 1] = mean(monthValues);
  }

  return {
    mean: meanArr,
    std: stdArr,
    monthlyNormal,
    annualMean: mean(annual),
    period,
    partialAnnualMean,
    partialMonthlyNormal,
  };
}
