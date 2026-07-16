const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadWorker(fetchImpl = async () => new Response('{}', {
  headers: { 'Content-Type': 'application/json' },
})) {
  const workerPath = path.join(__dirname, 'CORSAPI', '_worker.js');
  const source = fs.readFileSync(workerPath, 'utf8')
    .replace('export default {', 'const worker = {')
    .concat('\nglobalThis.__worker = worker;');

  const context = {
    AbortController,
    BigInt,
    Headers,
    Request,
    Response,
    Set,
    TextEncoder,
    URL,
    clearTimeout,
    console: { error() {}, log() {} },
    fetch: fetchImpl,
    setTimeout,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: workerPath });
  return context.__worker;
}

function proxyRequest(target, init) {
  return new Request(`https://worker.test/?url=${encodeURIComponent(target)}`, init);
}

test('health endpoint is available', async () => {
  const worker = loadWorker();
  const response = await worker.fetch(new Request('https://worker.test/health'), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'OK');
});

test('unsafe methods are rejected', async () => {
  const worker = loadWorker();
  const response = await worker.fetch(new Request('https://worker.test/', { method: 'POST' }), {});
  assert.equal(response.status, 405);
});

test('private network targets are blocked', async () => {
  const worker = loadWorker();
  const response = await worker.fetch(proxyRequest('http://127.0.0.1/private'), {});
  assert.equal(response.status, 403);
});

test('invalid source names and prefixes return 400', async () => {
  const worker = loadWorker();
  const badSource = await worker.fetch(new Request('https://worker.test/?format=0&source=unknown'), {});
  const badPrefix = await worker.fetch(new Request('https://worker.test/?format=1&prefix=javascript:alert(1)'), {});
  assert.equal(badSource.status, 400);
  assert.equal(badPrefix.status, 400);
});

test('proxy forwards only allowlisted request headers', async () => {
  let forwardedRequest;
  const worker = loadWorker(async request => {
    forwardedRequest = request;
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  });

  const response = await worker.fetch(proxyRequest('https://api.example.com/data', {
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer secret',
      Cookie: 'session=secret',
    },
  }), { PROXY_ALLOWED_HOSTS: 'api.example.com' });

  assert.equal(response.status, 200);
  assert.equal(forwardedRequest.headers.get('accept'), 'application/json');
  assert.equal(forwardedRequest.headers.has('authorization'), false);
  assert.equal(forwardedRequest.headers.has('cookie'), false);
});

test('redirects to private networks are blocked', async () => {
  const worker = loadWorker(async () => new Response(null, {
    status: 302,
    headers: { Location: 'http://127.0.0.1/private' },
  }));

  const response = await worker.fetch(
    proxyRequest('https://api.example.com/redirect'),
    { PROXY_ALLOWED_HOSTS: 'api.example.com' }
  );
  assert.equal(response.status, 502);
});

test('proxy errors redact secrets from target URLs', async () => {
  const worker = loadWorker(async () => { throw new Error('upstream failed'); });
  const response = await worker.fetch(
    proxyRequest('https://api.example.com/data?token=very-secret'),
    { PROXY_ALLOWED_HOSTS: 'api.example.com' }
  );
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.target.includes('very-secret'), false);
});
