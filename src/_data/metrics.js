// Computed metrics — the single derived layer for the whole site.
// Everything here is calculated from the two hand-edited sources of truth:
//   _data/organizations.json (the orgs we've supported)
//   _data/sales.json        (per-year candles, participants, dollars)
// Templates read `metrics.*` and never hardcode totals/growth/heights.
// Eleventy exposes this file's export as the `metrics` global (filename = key).

const organizations = require("./organizations.json");
const sales = require("./sales.json");
const site = require("./site.json");

const fmt = (n) => n.toLocaleString("en-US");
const round1 = (n) => Math.round(n * 10) / 10; // one decimal place
const round10 = (n) => Math.round(n / 10) * 10; // nearest ten

module.exports = (() => {
  const years = [...sales.perYear].sort((a, b) => a.year - b.year);
  const maxRaised = Math.max(...years.map((y) => y.raised));
  const latestYear = Math.max(...years.map((y) => y.year));
  // Tallest bar tops out at this % of the plot, leaving headroom for the $ label above it.
  const BAR_MAX_PCT = 82;

  // ---- per-year, carrying a running cumulative + previous-year reference ----
  let cumulative = 0;
  let prevRaised = null;
  const perYear = years.map((y) => {
    cumulative += y.raised;
    const growthPct = prevRaised === null ? null : round1(((y.raised - prevRaised) / prevRaised) * 100);
    const row = {
      year: y.year,
      raised: y.raised,
      raisedDisplay: fmt(y.raised),
      cumulative,
      cumulativeDisplay: fmt(cumulative),
      growthPct,
      growthDisplay: growthPct === null ? "start" : "+" + growthPct.toFixed(1) + "%",
      deltaDollars: prevRaised === null ? null : y.raised - prevRaised,
      barHeightPct: Math.round((y.raised / maxRaised) * BAR_MAX_PCT),
      isLatest: y.year === latestYear,
      candles: y.candles,
      candlesEstimate: y.candlesEstimate,
      participants: y.participants,
      participantsEstimate: y.participantsEstimate,
    };
    prevRaised = y.raised;
    return row;
  });

  const latest = perYear[perYear.length - 1];
  const totalRaised = perYear.reduce((s, y) => s + y.raised, 0);
  const totalCandles = perYear.reduce((s, y) => s + y.candles, 0);
  const totalParticipants = perYear.reduce((s, y) => s + y.participants, 0);
  const yearCount = perYear.length;
  const avgPerYear = Math.round(totalRaised / yearCount);

  // ---- records ----
  const biggestYearRow = perYear.reduce((a, b) => (b.raised > a.raised ? b : a));
  const biggestLeapRow = perYear
    .filter((y) => y.growthPct !== null)
    .reduce((a, b) => (b.growthPct > a.growthPct ? b : a));

  const records = {
    biggestYear: {
      year: biggestYearRow.year,
      raisedDisplay: "$" + biggestYearRow.raisedDisplay,
      candles: biggestYearRow.candles,
      participants: biggestYearRow.participants,
    },
    biggestLeap: {
      year: biggestLeapRow.year,
      growthDisplay: biggestLeapRow.growthDisplay,
      deltaDollars: biggestLeapRow.deltaDollars,
      deltaDisplay: "+$" + fmt(biggestLeapRow.deltaDollars),
    },
    tightestRace: {
      year: sales.tightestRace.year,
      spreadDisplay: sales.tightestRace.spreadPct + "%",
    },
  };

  // ---- candle math (playful estimates from total candles × documented constants) ----
  const c = sales.candleConstants;
  const burnHrs = Math.round(totalCandles * c.burnHrsPerCandle);
  const candleMath = {
    waxLbs: round10(totalCandles * c.waxLbsPerCandle),
    wickFt: round10(totalCandles * c.wickFtPerCandle),
    burnHrs,
    burnHrsDisplay: burnHrs >= 1000 ? Math.round(burnHrs / 1000) + "k" : fmt(burnHrs),
    avgPerYearDisplay: fmt(avgPerYear),
    bonus: sales.bonuses[0],
  };

  // ---- org slices that replace causes.json / charities.json ----
  const currentCauses = organizations.filter((o) => o.year === latestYear);
  const pastOrgs = organizations
    .filter((o) => o.year !== latestYear)
    .sort((a, b) => a.year - b.year);

  // ---- the home "raised" stat band (replaces site.raisedStats) ----
  const raisedStats = [
    { value: String(organizations.length), label: "Organizations supported" },
    { value: String(yearCount), label: "Years &amp; counting" },
    { value: "$" + sales.pricePerCandle, label: "Per candle &middot; same as day one" },
    { value: String(site.makers.length), label: "Things in the family" },
  ];

  // ---- the home impact-chart footer stats (replaces impact.json footStats) ----
  const footStats = [
    { value: String(latest.candles), label: "Candles hand-poured in " + latestYear },
    { value: String(latest.participants), label: "Neighbors who took part last year" },
    { value: latest.growthDisplay, label: "Growth over the year before" },
  ];

  return {
    perYear,
    latestYear,
    totalRaised,
    totalRaisedDisplay: fmt(totalRaised),
    totalCandles,
    totalCandlesDisplay: fmt(totalCandles),
    totalParticipants,
    orgCount: organizations.length,
    yearCount,
    avgPerYear,
    avgPerYearDisplay: fmt(avgPerYear),
    records,
    candleMath,
    currentCauses,
    pastOrgs,
    raisedStats,
    footStats,
  };
})();
