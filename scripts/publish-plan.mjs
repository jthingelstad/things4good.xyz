// What a deploy to S3 publishes, and how each file is served: its content type and Cache-Control.
// This is the control GitHub Pages, the host until the DNS cutover, never gave the site (it typed files by
// extension and cached everything ten minutes). An e2e test (tests/e2e/) fails when the build writes a
// file this table does not type, so a new kind of file is a decision, not octet-stream by default.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

// CNAME pins the custom domain for GitHub Pages; CloudFront has no use for it.
export const NOT_PUBLISHED = new Set(['CNAME']);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon'
};

// Extensions are matched in any case (a photo may arrive as .JPG).
export function contentTypeFor(key) {
  return TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream';
}

// Browsers keep every file five minutes; CloudFront keeps it a day, and every deploy clears CloudFront.
// Nothing the build writes is named by its content: the stylesheet's ?v= hash (base.njk) makes a browser
// fetch a new copy, but CloudFront's cache key ignores the query, so a long browser max-age on
// /styles.css could pin last deploy's copy under the new ?v= in the moments before the cache is cleared.
export function cacheControlFor() {
  return 'public, max-age=300, s-maxage=86400';
}

function walk(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(root, path);
    return entry.isFile() ? [relative(root, path).split(sep).join('/')] : [];
  });
}

// Every published file with its type and caching, in the order a deploy writes them: files first, then
// pages, the front page last, so no page goes out before what it loads.
export function publishPlan(root) {
  const rank = (key) => (key === 'index.html' ? 2 : key.endsWith('.html') ? 1 : 0);
  return walk(root)
    .filter((key) => !NOT_PUBLISHED.has(key) && !key.split('/').pop().startsWith('.'))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((key) => ({ key, path: join(root, key), contentType: contentTypeFor(key), cacheControl: cacheControlFor(key) }));
}
