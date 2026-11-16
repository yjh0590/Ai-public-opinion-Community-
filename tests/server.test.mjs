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
const payload = { text: '주 4일제 도입하면 어때?', mode: 'opinion', communities: ['dc'] };
const post = (url, body, extra = {}) => fetch(`${url}/api/reactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra });

test('serves Korean page and assets, keeps secrets and server files private', async () => {
  await withServer({ apiKey: '' }, async url => {
    assert.equal((await (await fetch(`${url}/api/status`)).json()).ai, false);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /생각 하나 던졌을 뿐인데/);
    for (const path of ['/styles.css', '/app.js', '/community.js', '/sites.js', '/favicon.svg']) assert.equal((await fetch(url + path)).status, 200);
    for (const path of ['/.env', '/server.mjs', '/package.json', '/.git/config']) assert.equal((await fetch(url + path)).status, 404);
  });
});

test('demo reacts in every site and supports third-person friend-story mode', async () => {
  await withServer({ apiKey: '' }, async url => {
    const single = await (await post(url, payload)).json();
    assert.equal(single.demo, true);
    assert.equal(single.reactions.length, 6);
    assert.ok(single.reactions.every(r => r.community === 'dc'));
    assert.ok(single.post.title && single.post.body.includes(payload.text));
    assert.equal(single.reactions.filter(r => r.replyTo >= 0).length, 1);
    assert.ok(single.reactions.every((r, i) => r.replyTo < i));
    const all = await (await post(url, { ...payload, communities: communities.map(c => c.id), mode: 'diary' })).json();
    assert.equal(all.reactions.length, communities.length * 3);
    assert.equal(new Set(all.reactions.map(r => r.community)).size, communities.length);
    assert.ok(all.post.body.includes('친구'));
    assert.ok(communities.every(c => all.reactions.filter(r => r.community === c.id).some(r => /친구|본인|아는 분|동기|언니/.test(r.text))));
  });
});

test('rejects invalid inputs, large bodies, and cross-origin requests', async () => {
  await withServer({ apiKey: '' }, async url => {
    for (const body of [{ ...payload, text: '' }, { ...payload, text: '가'.repeat(501) }, { ...payload, communities: ['unknown'] }, { ...payload, communities: ['dc', 'dc'] }, { ...payload, mode: 'unknown' }, null]) assert.equal((await post(url, body)).status, 400);
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
  const generatedPost = { title: '주4일제 도입 ㄹㅇ 해야 됨', body: '월요일 없어지면 삶의 질 수직상승임.' };
  const reactions = Array.from({ length: 6 }, () => ({ community: 'dc', nickname: '테스트봇', text: '주 4일제면 실제 업무량도 조정해야지.', likes: 3 }));
  await withServer({ apiKey: 'test-key', model: 'test-model', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    sent = JSON.parse(options.body);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ post: generatedPost, reactions }) }] }] });
  } }, async url => {
    const result = await (await post(url, payload)).json();
    assert.equal(result.demo, false);
    assert.deepEqual(result.reactions, reactions.map(r => ({ ...r, replyTo: -1 })));
    assert.deepEqual(result.post, generatedPost);
    assert.ok(sent.instructions.includes('디시인사이드 이용자가 직접 올린 듯한 게시글'));
    assert.equal(sent.store, false);
    assert.equal(sent.model, 'test-model');
    assert.equal(sent.input, payload.text);
    assert.equal(sent.text.format.type, 'json_schema');
    assert.ok(!JSON.stringify(result).includes('test-key'));
  });
});

test('Gemini mode sends the key in a header, asks for JSON schema output, and parses candidates', async () => {
  let sentUrl, sentHeaders, sent;
  const generatedPost = { title: '탕비실 간식 실종 사건 ㄹㅇ', body: '팀장님 책상에서 과자 봉지 나옴.' };
  // 1번은 0번에 대한 정상 답글, 2번은 아직 없는 댓글(5번)을 가리키는 잘못된 답글
  const reactions = Array.from({ length: 6 }, (_, i) => ({ community: 'dc', nickname: 'ㅇㅇ(1.2)', text: '노잼 ㄴㅈ', likes: 1, replyTo: [-1, 0, 5][i] ?? -1 }));
  await withServer({ provider: 'gemini', apiKey: 'gem-key', model: 'gem-model', fetchImpl: async (url, options) => {
    sentUrl = url; sentHeaders = options.headers; sent = JSON.parse(options.body);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ post: generatedPost, reactions }) }] } }] });
  } }, async url => {
    const result = await (await post(url, payload)).json();
    assert.equal(result.demo, false);
    assert.deepEqual(result.post, generatedPost);
    assert.deepEqual(result.reactions.map(r => r.replyTo), [-1, 0, -1, -1, -1, -1]);
    assert.ok(sent.generationConfig.responseJsonSchema.properties.reactions.items.required.includes('replyTo'));
    assert.equal(sentUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gem-model:generateContent');
    assert.equal(sentHeaders['x-goog-api-key'], 'gem-key');
    assert.ok(!sentUrl.includes('gem-key'));
    assert.equal(sent.generationConfig.responseMimeType, 'application/json');
    assert.ok(sent.systemInstruction.parts[0].text.includes('디시인사이드'));
    assert.equal(sent.contents[0].parts[0].text, payload.text);
  });
  await withServer({ provider: 'gemini', apiKey: 'gem-key', fetchImpl: async () => Response.json({ error: {} }, { status: 429 }) }, async url => {
    const result = await post(url, payload);
    assert.equal(result.status, 502);
    assert.match((await result.json()).error, /무료 사용량/);
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
