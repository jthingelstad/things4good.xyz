// Computed metrics — the single derived layer for the whole site.
// Everything here is calculated from the two hand-edited sources of truth:
//   _data/events.json (sale events + the nonprofits each one supported)
//   _data/site.json   (global config: price, candle constants, tightest race)
// Templates read `metrics.*` and never hardcode totals/growth/heights.
// Eleventy exposes this file's export as the `metrics` global (filename = key).

const data = require("./events.json");
const site = require("./site.json");

const fmt = (n) => n.toLocaleString("en-US");
const round1 = (n) => Math.round(n * 10) / 10; // one decimal place
const round10 = (n) => Math.round(n / 10) * 10; // nearest ten

module.exports = (() => {
  const events = data.events;
  const candleSaleEvents = events
    .filter((e) => e.kind === "candle-sale")
    .sort((a, b) => a.year - b.year);
  const specialEvents = events.filter((e) => e.kind === "special-event");

  // Money raised at a special event in a given candle-sale year (for the stacked bars).
  const specialRaisedInYear = (year) =>
    specialEvents.filter((e) => e.year === year).reduce((s, e) => s + e.raised, 0);

  const latestYear = Math.max(...candleSaleEvents.map((e) => e.year));
  // Bars stack candle sale + special events, so heights normalize to the tallest *combined* year.
  const maxYearTotal = Math.max(
    ...candleSaleEvents.map((e) => e.raised + specialRaisedInYear(e.year))
  );
  // Tallest bar tops out at this % of the plot, leaving headroom for the $ label above it.
  const BAR_MAX_PCT = 82;

  // ---- per-year, carrying a running cumulative + previous-year reference ----
  // Cumulative + growth are CANDLE-SALE ONLY — the "grown every year" story is about the sale.
  // Special events only add a stacked segment and feed the grand total.
  let cumulative = 0;
  let prevRaised = null;
  const perYear = candleSaleEvents.map((e) => {
    cumulative += e.raised;
    const growthPct = prevRaised === null ? null : round1(((e.raised - prevRaised) / prevRaised) * 100);
    const eventsRaised = specialRaisedInYear(e.year);
    const yearEvents = specialEvents
      .filter((ev) => ev.year === e.year)
      .map((ev) => ({ name: ev.name, raisedDisplay: fmt(ev.raised) }));
    const candleHeightPct = Math.round((e.raised / maxYearTotal) * BAR_MAX_PCT);
    const eventsHeightPct = Math.round((eventsRaised / maxYearTotal) * BAR_MAX_PCT);
    const row = {
      slug: e.slug,
      year: e.year,
      raised: e.raised,
      raisedDisplay: fmt(e.raised),
      cumulative,
      cumulativeDisplay: fmt(cumulative),
      growthPct,
      growthDisplay: growthPct === null ? "start" : "+" + growthPct.toFixed(1) + "%",
      deltaDollars: prevRaised === null ? null : e.raised - prevRaised,
      // stacked-bar segments
      eventsRaised,
      eventsRaisedDisplay: fmt(eventsRaised),
      yearTotal: e.raised + eventsRaised,
      yearTotalDisplay: fmt(e.raised + eventsRaised),
      yearEvents,
      candleHeightPct,
      eventsHeightPct,
      barHeightPct: candleHeightPct + eventsHeightPct,
      isLatest: e.year === latestYear,
      candles: e.candles,
      participants: e.participants,
    };
    prevRaised = e.raised;
    return row;
  });

  const latest = perYear[perYear.length - 1];
  const totalRaised = candleSaleEvents.reduce((s, e) => s + e.raised, 0);
  const eventsTotal = specialEvents.reduce((s, e) => s + e.raised, 0);
  const grandTotal = totalRaised + eventsTotal;
  const totalCandles = candleSaleEvents.reduce((s, e) => s + e.candles, 0);
  const totalParticipants = candleSaleEvents.reduce((s, e) => s + e.participants, 0);
  const yearCount = candleSaleEvents.length;
  const avgPerYear = Math.round(totalRaised / yearCount);

  // ---- the flat nonprofit ledger (every allocation across every event) ----
  // Replaces the old organizations.json global; feeds the Impact page + home logo wall.
  const nonprofits = events.flatMap((e) =>
    e.supported.map((s) => ({
      ...s,
      year: e.year,
      eventKind: e.kind,
      eventName: e.name,
      event: e.slug,
    }))
  );

  // ---- the Impact-page event filter (newest first) ----
  const eventList = [...events]
    .sort((a, b) => b.year - a.year || (a.kind === "candle-sale" ? -1 : 1))
    .map((e) => ({ slug: e.slug, name: e.name, year: e.year, kind: e.kind }));

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
      year: site.tightestRace.year,
      spreadDisplay: site.tightestRace.spreadPct + "%",
    },
  };

  // ---- candle math (playful estimates from total candles × documented constants) ----
  const c = site.candleConstants;
  const burnHrs = Math.round(totalCandles * c.burnHrsPerCandle);
  const candleMath = {
    waxLbs: round10(totalCandles * c.waxLbsPerCandle),
    wickFt: round10(totalCandles * c.wickFtPerCandle),
    burnHrs,
    burnHrsDisplay: burnHrs >= 1000 ? Math.round(burnHrs / 1000) + "k" : fmt(burnHrs),
    avgPerYearDisplay: fmt(avgPerYear),
  };

  // ---- the home "raised" stat band ----
  const raisedStats = [
    { value: String(nonprofits.length), label: "Organizations supported" },
    { value: String(yearCount), label: "Years &amp; counting" },
    { value: "$" + site.pricePerCandle, label: "Per candle &middot; same as day one" },
    { value: String(site.makers.length), label: "Things in the family" },
  ];

  // ---- the home impact-chart footer stats ----
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
    eventsTotal,
    eventsTotalDisplay: fmt(eventsTotal),
    grandTotal,
    grandTotalDisplay: fmt(grandTotal),
    totalCandles,
    totalCandlesDisplay: fmt(totalCandles),
    totalParticipants,
    orgCount: nonprofits.length,
    yearCount,
    avgPerYear,
    avgPerYearDisplay: fmt(avgPerYear),
    pricePerCandle: site.pricePerCandle,
    nonprofits,
    eventList,
    records,
    candleMath,
    raisedStats,
    footStats,
  };
})();
