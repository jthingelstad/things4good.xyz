// The S3 and CloudFront hosting: the viewer-request function, how each file is typed and cached, and the
// committed templates matching their source. tests/e2e/ checks the same against a real build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { viewerRequestCode } from "../infra/viewer-request.mjs";
import { certificate, site, delivery } from "../infra/templates.mjs";
import { cacheControlFor, contentTypeFor } from "../scripts/publish-plan.mjs";

const handler = new Function(viewerRequestCode + "\nreturn handler;")();
const request = (uri, { host = "things4good.xyz", querystring = {} } = {}) =>
  handler({ request: { uri, querystring, headers: { host: { value: host } } } });

test("www answers with one 301 to the apex, keeping the path and the query", () => {
  const home = request("/", { host: "www.things4good.xyz" });
  assert.equal(home.statusCode, 301);
  assert.equal(home.headers.location.value, "https://things4good.xyz/");
  const deep = request("/impact/", {
    host: "WWW.things4good.xyz",
    querystring: { ref: { value: "share" }, year: { value: "2025", multiValue: [{ value: "2024" }, { value: "2025" }] } },
  });
  assert.equal(deep.statusCode, 301);
  assert.equal(deep.headers.location.value, "https://things4good.xyz/impact/?ref=share&year=2024&year=2025");
  // A bare path goes straight to the slash form on the apex, one hop.
  const bare = request("/faq", { host: "www.things4good.xyz", querystring: { q: { value: "" } } });
  assert.equal(bare.headers.location.value, "https://things4good.xyz/faq/?q");
  // A file keeps its path.
  assert.equal(request("/styles.css", { host: "www.things4good.xyz" }).headers.location.value, "https://things4good.xyz/styles.css");
});

test("on the apex, directory URLs serve index.html, a bare path gets its slash, files pass", () => {
  assert.equal(request("/").uri, "/index.html");
  assert.equal(request("/impact/").uri, "/impact/index.html");
  const bare = request("/impact", { querystring: { ref: { value: "x" } } });
  assert.equal(bare.statusCode, 301);
  assert.equal(bare.headers.location.value, "/impact/?ref=x");
  assert.equal(request("/styles.css").uri, "/styles.css");
  assert.equal(request("/images/logos/oceanites.png").uri, "/images/logos/oceanites.png");
  // The cloudfront.net domain behaves as the apex.
  assert.equal(request("/stats/", { host: "d123.cloudfront.net" }).uri, "/stats/index.html");
});

test("every kind of file the build writes has its own type", () => {
  assert.equal(contentTypeFor("index.html"), "text/html; charset=utf-8");
  assert.equal(contentTypeFor("styles.css"), "text/css; charset=utf-8");
  assert.equal(contentTypeFor("sitemap.xml"), "application/xml; charset=utf-8");
  assert.equal(contentTypeFor("llms.txt"), "text/plain; charset=utf-8");
  assert.equal(contentTypeFor("robots.txt"), "text/plain; charset=utf-8");
  assert.equal(contentTypeFor("favicon.svg"), "image/svg+xml");
  assert.equal(contentTypeFor("images/cards/home.jpg"), "image/jpeg");
  assert.equal(contentTypeFor("images/family/JAMIE.JPG"), "image/jpeg");
  assert.equal(contentTypeFor("images/logos/oceanites.png"), "image/png");
  assert.equal(contentTypeFor("mystery.bin"), "application/octet-stream");
});

test("every file is five minutes in browsers and a day in CloudFront, which each deploy clears", () => {
  for (const key of ["index.html", "styles.css", "images/cards/home.jpg"])
    assert.equal(cacheControlFor(key), "public, max-age=300, s-maxage=86400");
});

test("the distribution carries both names, and the certificate covers both", () => {
  assert.deepEqual(certificate.Resources.Certificate.Properties.SubjectAlternativeNames, ["www.things4good.xyz"]);
  assert.equal(certificate.Resources.Certificate.Properties.DomainName, "things4good.xyz");
  const config = site.Resources.Distribution.Properties.DistributionConfig;
  assert.deepEqual(config.Aliases["Fn::If"][1], ["things4good.xyz", "www.things4good.xyz"]);
});

test("access logs carry no viewer IP and no query string", () => {
  const fields = site.Resources.AccessLogDelivery.Properties.RecordFields;
  assert.ok(!fields.includes("c-ip") && !fields.includes("cs-uri-query"));
  assert.equal(site.Resources.AccessLogGroup.Properties.LogGroupName, "/things4good/web-access");
  assert.equal(site.Resources.AccessLogGroup.Properties.RetentionInDays, 14);
});

test("the committed templates are what infra/templates.mjs writes", () => {
  for (const [name, body] of Object.entries({ certificate, site, delivery }))
    assert.deepEqual(JSON.parse(readFileSync(`infra/generated/${name}.json`, "utf8")), body, `run npm run infra:generate (${name})`);
});
