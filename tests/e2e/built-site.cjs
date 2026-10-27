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
