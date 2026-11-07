// The order window as of this build: site.json's orders, run through the rule the order service keeps
// (currentWindow in infra/order-service.mjs). A window shuts on its own at `closes`: the service stops
// taking orders that minute, the order page believes the service over this build, and the daily build
// just after midnight Central (deploy.yml) brings the nav and the other pages along.
//
//   window      preorder | paused | after | closed, as of now
//   open        preorder or after
//   saleOn      paused, and the sale isn't over yet (saleEnds)
//   closesDay   "Sunday, Nov 8", and closesTime "11:59 p.m.", in Central, while open
//   goldenTicket  Golden Tickets are on the form
const site = require("./site.json");

const CENTRAL = "America/Chicago";
const day = (iso) =>
  new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, weekday: "long", month: "short", day: "numeric" }).format(new Date(iso));
const time = (iso) =>
  new Intl.DateTimeFormat("en-US", { timeZone: CENTRAL, hour: "numeric", minute: "2-digit" })
    .format(new Date(iso))
    .replace(/\s*AM$/, " a.m.")
    .replace(/\s*PM$/, " p.m.");

module.exports = async () => {
  const { currentWindow, isOpen } = await import("../../infra/order-service.mjs");
  const orders = site.orders ?? {};
  const now = Date.now();
  const window = currentWindow(orders, now);
  const open = isOpen(window);
  return {
    window,
    open,
    preorder: window === "preorder",
    after: window === "after",
    paused: window === "paused",
    saleOn: window === "paused" && now < Date.parse(orders.saleEnds),
    closes: open ? orders.closes : "",
    closesDay: open ? day(orders.closes) : "",
    closesTime: open ? time(orders.closes) : "",
    saleEnds: orders.saleEnds ?? "",
    reopens: orders.reopens ?? "",
    goldenTicket: orders.goldenTicket === true,
  };
};
