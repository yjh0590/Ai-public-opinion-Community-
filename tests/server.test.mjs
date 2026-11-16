import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { communities } from '../public/community.js';

async function withServer(options, run) {
  const server = createApp(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await run(url); } finally { await new Promise(resolve => server.close(resolve)); }
}
const payload = { text: '주 4일제 도입하면 어때?', mode: 'opinion', communities: ['square'] };
const post = (url, body, extra = {}) => fetch(`${url}/api/reactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra });

test('serves Korean page and assets, keeps secrets and server files private', async () => {
  await withServer({ apiKey: '' }, async url => {
    assert.equal((await (await fetch(`${url}/api/status`)).json()).ai, false);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /생각 하나 던졌을 뿐인데/);
    for (const path of ['/styles.css', '/app.js', '/community.js', '/favicon.svg']) assert.equal((await fetch(url + path)).status, 200);
    for (const path of ['/.env', '/server.mjs', '/package.json', '/.git/config']) assert.equal((await fetch(url + path)).status, 404);
  });
});

test('demo reacts in all seven atmospheres and supports AI diary mode', async () => {
  await withServer({ apiKey: '' }, async url => {
    const single = await (await post(url, payload)).json();
    assert.equal(single.demo, true);
    assert.equal(single.reactions.length, 6);
    assert.ok(single.reactions.every(r => r.community === 'square'));
    const all = await (await post(url, { ...payload, communities: communities.map(c => c.id), mode: 'diary' })).json();
    assert.equal(all.reactions.length, 21);
    assert.equal(new Set(all.reactions.map(r => r.community)).size, 7);
    assert.ok(all.reactions.every(r => r.nickname.endsWith('봇')));
  });
});

test('rejects invalid inputs, large bodies, and cross-origin requests', async () => {
  await withServer({ apiKey: '' }, async url => {
    for (const body of [{ ...payload, text: '' }, { ...payload, text: '가'.repeat(501) }, { ...payload, communities: ['unknown'] }, { ...payload, communities: ['square', 'square'] }, { ...payload, mode: 'unknown' }, null]) assert.equal((await post(url, body)).status, 400);
    assert.equal((await post(url, { ...payload, text: '가'.repeat(10000) })).status, 413);
    assert.equal((await post(url, payload, { headers: { 'Content-Type': 'application/json', Origin: 'https://other.example' } })).status, 403);
  });
});

test('rate limits repeated requests', async () => {
  await withServer({ apiKey: '' }, async url => {
    for (let i = 0; i < 10; i++) assert.equal((await post(url, payload)).status, 200);
    assert.equal((await post(url, payload)).status, 429);
  });
});

test('real AI mode sends instructions and parses structured Responses output', async () => {
  let sent;
  const reactions = Array.from({ length: 6 }, () => ({ community: 'square', nickname: '테스트봇', text: '주 4일제면 실제 업무량도 조정해야지.', likes: 3 }));
  await withServer({ apiKey: 'test-key', model: 'test-model', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    sent = JSON.parse(options.body);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ reactions }) }] }] });
  } }, async url => {
    const result = await (await post(url, payload)).json();
    assert.equal(result.demo, false);
    assert.deepEqual(result.reactions, reactions);
    assert.equal(sent.store, false);
    assert.equal(sent.model, 'test-model');
    assert.equal(sent.input, payload.text);
    assert.equal(sent.text.format.type, 'json_schema');
    assert.ok(!JSON.stringify(result).includes('test-key'));
  });
});

test('provider failures and refused or incomplete output never silently become demo', async () => {
  for (const providerResponse of [Response.json({ error: 'private-provider-detail' }, { status: 401 }), Response.json({ status: 'completed', output: [] }), Response.json({ status: 'incomplete' }), Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"reactions":[]}' }] }] })]) {
    await withServer({ apiKey: 'test-key', fetchImpl: async () => providerResponse }, async url => {
      const result = await post(url, payload);
      assert.equal(result.status, 502);
      const data = await result.json();
      assert.equal(typeof data.error, 'string');
      assert.ok(!data.error.includes('private-provider-detail'));
      assert.equal(data.demo, undefined);
    });
  }
});
