// Checks against the built site (_site/), so run after `npm run build` (`npm run test:e2e`; CI does).
// What the S3 deploy publishes must match the build: the viewer-request function knows every
// extensionless file, and every file has a content type chosen for it.
const test = require('node:test');
const assert = require('node:assert/strict');

test('the function knows every extensionless file, and every file is typed', async () => {
  const { FILES } = await import('../../infra/viewer-request.mjs');
  const { publishPlan } = await import('../../scripts/publish-plan.mjs');
  const plan = publishPlan('_site');
  const keys = plan.map((file) => file.key);
  assert.ok(keys.includes('index.html') && keys.includes('404.html'));
  const bare = keys.filter((key) => !key.split('/').pop().includes('.')).map((key) => '/' + key);
  assert.deepEqual(bare.sort(), [...FILES].sort());
  const untyped = plan.filter((file) => file.contentType === 'application/octet-stream');
  assert.deepEqual(untyped.map((file) => file.key), [], 'add these to TYPES in scripts/publish-plan.mjs');
});

test('every sitemap url has a valid lastmod', () => {
  const xml = require('node:fs').readFileSync('_site/sitemap.xml', 'utf8');
  const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => match[1]);
  assert.ok(urls.length >= 5);
  for (const url of urls) {
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(url)?.[1];
    assert.ok(lastmod, `no lastmod in ${url}`);
    assert.match(lastmod, /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/);
    assert.ok(!Number.isNaN(Date.parse(lastmod)));
  }
});
