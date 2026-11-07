// The S3 and CloudFront hosting: the viewer-request function, how each file is typed and cached, and the
// committed templates matching their source. tests/e2e/ checks the same against a real build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { viewerRequestCode } from "../infra/viewer-request.mjs";
import { certificate, site, delivery, orders } from "../infra/templates.mjs";
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
  assert.equal(site.Resources.AccessLogGroup.Properties.RetentionInDays, 731);
});

test("the committed templates are what infra/templates.mjs writes", () => {
  for (const [name, body] of Object.entries({ certificate, site, delivery, orders }))
    assert.deepEqual(JSON.parse(readFileSync(`infra/generated/${name}.json`, "utf8")), body, `run npm run infra:generate (${name})`);
});

test("/api/ goes to the order service, without the slash function and without the site's open CORS", () => {
  const config = site.Resources.Distribution.Properties.DistributionConfig;
  const [behavior] = config.CacheBehaviors;
  assert.equal(config.CacheBehaviors.length, 1);
  assert.equal(behavior.PathPattern, "/api/*");
  assert.equal(behavior.TargetOriginId, "orders");
  assert.ok(behavior.AllowedMethods.includes("POST"));
  assert.equal(behavior.FunctionAssociations, undefined);
  assert.deepEqual(behavior.ResponseHeadersPolicyId, { Ref: "OrderHeaders" });
  assert.equal(site.Resources.OrderHeaders.Properties.ResponseHeadersPolicyConfig.CorsConfig, undefined);
  const origin = config.Origins.find((o) => o.Id === "orders");
  assert.deepEqual(origin.OriginAccessControlId, { Ref: "OrderOriginAccess" });
  assert.equal(site.Resources.OrderOriginAccess.Properties.OriginAccessControlConfig.OriginAccessControlOriginType, "lambda");
  // The signature needs the body's hash, and must be for the function URL's name, not the site's.
  const { Headers } = site.Resources.OrderOriginRequest.Properties.OriginRequestPolicyConfig.HeadersConfig;
  assert.ok(Headers.includes("x-amz-content-sha256"));
  assert.ok(!Headers.map((h) => h.toLowerCase()).includes("host"));
});

test("the order function runs one at a time, behind IAM, and only it can read the key", () => {
  const { Function: fn, FunctionUrl, SecretPolicy, Role, Logs, CloudFrontInvoke, CloudFrontInvokeUrl } = orders.Resources;
  assert.equal(fn.Properties.ReservedConcurrentExecutions, 1);
  assert.equal(FunctionUrl.Properties.AuthType, "AWS_IAM");
  assert.equal(CloudFrontInvoke.Properties.Principal, "cloudfront.amazonaws.com");
  assert.equal(CloudFrontInvoke.Properties.Action, "lambda:InvokeFunction");
  assert.equal(CloudFrontInvokeUrl.Properties.Action, "lambda:InvokeFunctionUrl");
  const [deny] = SecretPolicy.Properties.ResourcePolicy.Statement;
  assert.equal(deny.Effect, "Deny");
  assert.equal(deny.Action, "secretsmanager:GetSecretValue");
  assert.deepEqual(deny.Condition.StringNotEquals["aws:PrincipalArn"], { "Fn::GetAtt": ["Role", "Arn"] });
  const reads = Role.Properties.Policies[0].PolicyDocument.Statement.find((s) => s.Action === "secretsmanager:GetSecretValue");
  assert.deepEqual(reads.Resource, { Ref: "Secret" });
  assert.equal(Logs.Properties.RetentionInDays, 90);
});

test("errors alarm, whether the service caught them or Lambda did", () => {
  const { ErrorAlarm, ErrorFilter } = orders.Resources;
  assert.equal(ErrorFilter.Properties.FilterPattern, '{ $.level = "ERROR" }');
  assert.match(JSON.stringify(ErrorAlarm.Properties.AlarmActions), /projects-sysadmin-alarms/);
  const names = ErrorAlarm.Properties.Metrics.filter((m) => m.MetricStat).map((m) => m.MetricStat.Metric.MetricName);
  assert.deepEqual(names.sort(), ["Errors", "ServiceErrors"]);
});

test("no CloudFormation description has an em dash", () => {
  for (const body of [site, orders]) assert.ok(!JSON.stringify(body).includes("\u2014"));
});
