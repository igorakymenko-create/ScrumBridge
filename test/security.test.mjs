import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, makeSession } from './helpers.mjs';

describe('access control', () => {
  let s;
  before(async () => { s = await startServer({ session: makeSession() }); });
  after(() => s.stop());

  it('refuses the chat page without the token', async () => {
    const r = await fetch(s.base + '/');
    assert.equal(r.status, 401);
  });

  it('refuses a wrong token in the link', async () => {
    const r = await fetch(s.base + '/?token=nope', { redirect: 'manual' });
    assert.equal(r.status, 401);
  });

  it('turns a good token link into an HttpOnly, SameSite=Strict cookie and a redirect', async () => {
    const r = await fetch(`${s.base}/?token=${s.token}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`^aist_${s.port}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  it('serves the page with the project id and session to a cookie holder', async () => {
    const r = await fetch(s.base + '/', { headers: s.cookie });
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.match(html, /window\.__AIST_SERVER__=true/);
    assert.match(html, /window\.__AIST_PROJECT__="[0-9a-f]{12}"/);
    assert.match(html, /"title":"Test"/);
  });

  it('refuses /api without credentials, accepts a Bearer token and a cookie', async () => {
    assert.equal((await s.api('GET', '/api/session', undefined, {})).status, 401);
    assert.equal((await s.api('GET', '/api/session')).status, 200);
    assert.equal((await s.api('GET', '/api/session', undefined, s.cookie)).status, 200);
  });

  it('refuses a foreign Host header (DNS rebinding)', async () => {
    // fetch() ignores a custom Host header, so this goes through the raw http client
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/session', headers: { ...s.bearer, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
  });

  it('refuses a foreign Origin, accepts a local one', async () => {
    assert.equal((await s.api('GET', '/api/session', undefined, { ...s.bearer, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await s.api('GET', '/api/session', undefined, { ...s.bearer, Origin: s.base })).status, 200);
  });

  it('keeps /mcp open to local callers so IDE configs need no token', async () => {
    const r = await s.mcp('ping');
    assert.equal(r.text, 'pong');
  });

  it('refuses writes from a browser tab of another project, but not from scripts or from the right tab', async () => {
    const body = makeSession({ title: 'from a tab' });
    const wrongTab = await s.api('PUT', '/api/session', body, { ...s.cookie, 'X-Aist-Project': 'ffffffffffff' });
    assert.equal(wrongTab.status, 409);
    const noId = await s.api('PUT', '/api/session', body, s.cookie);
    assert.equal(noId.status, 409);
    assert.equal(JSON.parse(s.read('.ai-team/session.json')).title, 'Test', 'the stale tab must not change the data');
    const id = (await (await fetch(s.base + '/', { headers: s.cookie })).text()).match(/__AIST_PROJECT__="([0-9a-f]{12})"/)[1];
    assert.equal((await s.api('PUT', '/api/session', body, { ...s.cookie, 'X-Aist-Project': id })).status, 200);
    assert.equal((await s.api('PUT', '/api/session', makeSession({ title: 'from a script' }))).status, 200);
  });

  it('does not require the project id for provider settings', async () => {
    const r = await s.api('GET', '/api/llm/providers', undefined, s.cookie);
    assert.equal(r.status, 200);
  });
});

describe('page injection', () => {
  let s;
  before(async () => { s = await startServer({ session: makeSession({ title: 'x</script><script>alert(1)</script>' }) }); });
  after(() => s.stop());

  it('cannot be broken out of by text in the session', async () => {
    const html = await (await fetch(s.base + '/', { headers: s.cookie })).text();
    const injected = html.slice(0, html.indexOf('window.__AIST_SESSION__'));
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag from the session must not appear');
    assert.ok(html.includes('\\u003c/script>'), 'the < must be escaped inside the injected JSON');
    assert.ok(injected.length > 0);
  });
});
