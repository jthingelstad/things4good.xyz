// The viewer-request CloudFront Function (cloudfront-js-2.0), kept as source here so the tests can run it.
//
// Any www. host answers with one 301 to the apex, keeping the path (already in its slash form) and the
// query string as the viewer sent it. S3 behind Origin Access Control serves no directory indexes, so
// "/impact/" is rewritten to its index.html and "/impact" is sent to the slash form. A path whose last
// segment has a dot is a file and passes through, and so do the extensionless files the deploy publishes
// (FILES, which a test keeps equal to the publish plan; there are none).
export const APEX = 'things4good.xyz';
export const FILES = [];

export const viewerRequestCode = `var apex = 'https://${APEX}';
var files = ${JSON.stringify(Object.fromEntries(FILES.map((file) => [file, true])))};

function search(querystring) {
  var parts = [];
  for (var name in querystring) {
    var item = querystring[name];
    var values = item.multiValue ? item.multiValue : [item];
    for (var i = 0; i < values.length; i++) parts.push(values[i].value === '' ? name : name + '=' + values[i].value);
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function moved(location) {
  return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: location } } };
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var host = request.headers && request.headers.host ? request.headers.host.value.toLowerCase() : '';
  var bare = !files[uri] && !uri.endsWith('/') && !uri.split('/').pop().includes('.');
  var target = bare ? uri + '/' : uri;
  if (host.indexOf('www.') === 0) return moved(apex + target + search(request.querystring));
  if (files[uri]) return request;
  if (bare) return moved(target + search(request.querystring));
  if (uri.endsWith('/')) request.uri = uri + 'index.html';
  return request;
}
`;
