// Computed metrics — the single derived layer for the whole site.
// Everything here is calculated from the two hand-edited sources of truth:
//   _data/events.json (sale events + the nonprofits each one supported)
//   _data/site.json   (global config: price, candle constants, tightest race)
// Templates read `metrics.*` and never hardcode totals/growth/heights.
// Eleventy exposes this file's export as the `metrics` global (filename = key).

const data = require("./events.json");
const site = require("./site.json");
const saleStats = require("./saleStats.json");

const fmt = (n) => n.toLocaleString("en-US");
const round1 = (n) => Math.round(n * 10) / 10; // one decimal place
const round10 = (n) => Math.round(n / 10) * 10; // nearest ten
const pct = (n) => (n === null || n === undefined ? "" : n.toFixed(1) + "%");

module.exports = (() => {
  const events = data.events;
  const candleSaleEvents = events
    .filter((e) => e.kind === "candle-sale")
    .sort((a, b) => a.year - b.year);
  const specialEvents = events.filter((e) => e.kind === "special-event");
  const postsForEvent = (e) =>
    (e.posts || []).map((p, index) => ({
      ...p,
      index,
      year: e.year,
      event: e.slug,
      eventKind: e.kind,
      eventName: e.name,
    }));

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
      takeaway: e.takeaway || "",
      posts: postsForEvent(e),
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
    .map((e) => ({
      slug: e.slug,
      name: e.name,
      year: e.year,
      kind: e.kind,
      raised: e.raised,
      raisedDisplay: fmt(e.raised),
      candles: e.candles || null,
      participants: e.participants || null,
      orgCount: e.supported.length,
      takeaway: e.takeaway || e.note || "",
    }));

  // ---- curated blog archive ----
  // Blog posts stay manually curated in events.json so this site can highlight the
  // best context without trying to mirror the whole Things 4 Good category feed.
  const allPosts = candleSaleEvents
    .flatMap(postsForEvent)
    .sort((a, b) => b.year - a.year || a.index - b.index);
  const featuredPosts = allPosts.filter((p) => p.featured).slice(0, 3);
  const journalPosts = featuredPosts.length ? featuredPosts : allPosts.slice(0, 3);
  const annualStories = [...candleSaleEvents]
    .reverse()
    .map((e) => {
      const row = perYear.find((y) => y.slug === e.slug);
      return {
        slug: e.slug,
        year: e.year,
        name: e.name,
        raisedDisplay: row ? row.raisedDisplay : fmt(e.raised),
        candles: e.candles,
        participants: e.participants,
        takeaway: e.takeaway || "",
        posts: postsForEvent(e),
      };
    })
    .filter((e) => e.posts.length);

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

  // ---- operational sale stats ----
  // Nonprofit dollars remain canonical in events.json. These are aggregate, non-PII
  // operating metrics curated from the private sales spreadsheets.
  const saleYears = saleStats.years;
  const maxSaleRaised = Math.max(...saleYears.map((y) => y.raised));
  const maxSaleCandles = Math.max(...saleYears.map((y) => y.candlesSold));
  const maxSaleTransactions = Math.max(...saleYears.map((y) => y.transactions));
  const latestSale = saleYears[saleYears.length - 1];
  const totalTransactions = saleYears.reduce((s, y) => s + y.transactions, 0);
  const totalCandlesSold = saleYears.reduce((s, y) => s + y.candlesSold, 0);
  const totalPaymentCount = saleYears.flatMap((y) => y.paymentMethods).reduce((s, p) => s + p.count, 0);
  const totalVenmoCount = saleYears
    .flatMap((y) => y.paymentMethods)
    .filter((p) => p.method === "Venmo")
    .reduce((s, p) => s + p.count, 0);
  const latestPaymentTotal = latestSale.paymentMethods.reduce((s, p) => s + p.count, 0);
  const latestVenmoCount = latestSale.paymentMethods.find((p) => p.method === "Venmo")?.count || 0;
  const orderTotals = new Map();
  saleYears.forEach((y) => {
    y.orderDistribution.forEach((d) => {
      orderTotals.set(d.candles, (orderTotals.get(d.candles) || 0) + d.transactions);
    });
  });
  const allOrderDistribution = [...orderTotals.entries()]
    .map(([candles, transactions]) => ({ candles, transactions }))
    .sort((a, b) => a.candles - b.candles);
  const maxOrderTransactions = Math.max(...allOrderDistribution.map((d) => d.transactions));
  const latestMaxOrderTransactions = Math.max(...latestSale.orderDistribution.map((d) => d.transactions));
  const maxLatestScentSold = Math.max(...latestSale.scents.map((s) => s.sold));
  const topLatestScent = latestSale.scents.reduce((a, b) => (b.sold > a.sold ? b : a));
  const latestLeft = latestSale.candlesLeft || 0;
  const operations = {
    sourceNote: saleStats._note,
    years: saleYears.map((y) => ({
      ...y,
      raisedDisplay: fmt(y.raised),
      growthDisplay: y.growthPct === null ? "start" : "+" + pct(y.growthPct),
      transactionGrowthDisplay: y.transactionGrowthPct === null ? "start" : pct(y.transactionGrowthPct),
      raisedBarPct: Math.round((y.raised / maxSaleRaised) * 100),
      candleBarPct: Math.round((y.candlesSold / maxSaleCandles) * 100),
      transactionBarPct: Math.round((y.transactions / maxSaleTransactions) * 100),
    })),
    latest: {
      ...latestSale,
      raisedDisplay: fmt(latestSale.raised),
      venmoShareDisplay: pct((latestVenmoCount / latestPaymentTotal) * 100),
      paymentTotal: latestPaymentTotal,
      maxOrderTransactions: latestMaxOrderTransactions,
      scents: latestSale.scents.map((s) => ({
        ...s,
        barPct: Math.round((s.sold / maxLatestScentSold) * 100),
        leftDisplay: s.left === 0 ? "sold out" : s.left > 0 ? s.left + " left" : Math.abs(s.left) + " over",
      })),
    },
    totals: {
      candlesSold: totalCandlesSold,
      candlesSoldDisplay: fmt(totalCandlesSold),
      transactions: totalTransactions,
      avgCandlesPerTransaction: (totalCandlesSold / totalTransactions).toFixed(1),
      paymentCount: totalPaymentCount,
      venmoCount: totalVenmoCount,
      venmoShareDisplay: pct((totalVenmoCount / totalPaymentCount) * 100),
      waxLbs: Math.round(totalCandlesSold * c.waxLbsPerCandle),
      wickFt: Math.round(totalCandlesSold * c.wickFtPerCandle),
      burnHrsDisplay: fmt(Math.round(totalCandlesSold * c.burnHrsPerCandle)),
      latestLeft,
    },
    allOrderDistribution: allOrderDistribution.map((d) => ({
      ...d,
      barPct: Math.round((d.transactions / maxOrderTransactions) * 100),
    })),
    latestOrderDistribution: latestSale.orderDistribution.map((d) => ({
      ...d,
      barPct: Math.round((d.transactions / latestMaxOrderTransactions) * 100),
    })),
    topLatestScent,
    milestones: saleStats.milestones,
    materialCost: {
      ...saleStats.materialCost,
      costRangeDisplay: "$" + saleStats.materialCost.costLow.toFixed(2) + "-$" + saleStats.materialCost.costHigh.toFixed(2),
      discountRangeDisplay: "$" + saleStats.materialCost.discountLow.toFixed(2) + "-$" + saleStats.materialCost.discountHigh.toFixed(2),
      allTimeCostRangeDisplay:
        "$" + fmt(Math.round(totalCandlesSold * saleStats.materialCost.discountLow)) +
        "-$" + fmt(Math.round(totalCandlesSold * saleStats.materialCost.discountHigh)),
    },
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
    allPosts,
    journalPosts,
    annualStories,
    records,
    candleMath,
    operations,
    raisedStats,
    footStats,
  };
})();
