import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import { apply as official } from '@deepseek-ai/dsh-compaction-image-offload';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { apply, isVisionBudgetFailure } from '../index.js';

const body = {code:'media_budget_exceeded', message:'vision raw patches exceed processor budget', param:'messages', type:'invalid_request_error'};
const failure = (b = body) => ({code:'INVALID_REQUEST', message:`400: ${JSON.stringify(b)}`});
function fixture(n = 3, enabled = true, maxRetries = 32) {
  const ctx = new Context();
  let projection;
  const decisions = [];
  const events = Array.from({length:n}, (_, seq) => ({type:seq % 2 ? 'tool/result' : 'user/message', seq,
    data:{role:'user', content:[{type:'image', attachment:{attachmentId:`a${seq}`}}]}}));
  const messages = new Map(events.map(e => [e.seq, e.data]));
  const session = {surface:{nodes:events.map(e=>e.seq)}, eventAt:i=>events[i], deriveEventMessage:e=>messages.get(e.seq),
    append(type, data) {
      const event = {type, data};
      const projected = projection.project(event, {nodes:this.surface.nodes, events, baseSeq:0, messages});
      for (const [seq, message] of projected) messages.set(seq, message);
      decisions.push(event);
    }};
  // Real Cordis waterfall + real official listener and durable projection.
  if (enabled) official({sessions:{registerMessageProjection:p=>{projection=p;}}, on:ctx.on.bind(ctx)});
  apply(ctx, {providers:['ninfer'], maxRetries});
  const agent = {session};
  const run = (f = failure(), extra = {}) => ctx.waterfall('agent/request-error',
    {agent, turn:1, step:0, provider:'ninfer', failure:f, signal:new AbortController().signal, ...extra}, async()=>undefined);
  return {run, decisions, messages, ctx, agent};
}
test('exact NInfer signature and supported HTTP formatting', () => {
  assert.equal(isVisionBudgetFailure(failure()), true);
  assert.equal(isVisionBudgetFailure({...failure(), message:`HTTP 400\n${JSON.stringify(body)}`}), true);
  assert.equal(isVisionBudgetFailure(failure({error:body})), true);
});
test('reject unrelated HTTP, media, context, malformed and incomplete failures', () => {
  for (const f of [
    {...failure(), code:'CONTEXT_WINDOW_EXCEEDED'}, {...failure(), status:413},
    {...failure(), message:failure().message.replace('400','500')},
    failure({...body, code:'other_media_error'}), failure({...body, message:'too many images'}),
    failure({...body, type:'other'}), failure({...body, param:'input'}),
    {code:'INVALID_REQUEST', message:'400 invalid request'},
    {code:'INVALID_REQUEST', message:'400: {bad json}'},
    {code:'INVALID_REQUEST', message:JSON.stringify(body)},
    failure({...body, message:'maximum context length exceeded'}),
  ]) assert.equal(isVisionBudgetFailure(f), false, JSON.stringify(f));
});
test('official handoff persists one oldest omission and preserves newest', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), {kind:'retry'});
  assert.deepEqual(f.decisions[0].data.targets, [{seq:0,imageIndexes:[0]}]);
  assert.deepEqual(await f.run(), {kind:'retry'});
  assert.deepEqual(f.decisions[1].data.targets, [{seq:1,imageIndexes:[0]}]);
  await assert.rejects(f.run(), /no older eligible image/);
  assert.equal(f.messages.get(2).content[0].offloaded, undefined);
  assert.equal(f.decisions.length, 2);
});
test('terminates at bound and without official executor', async () => {
  const bounded = fixture(5, true, 1);
  await bounded.run();
  await assert.rejects(bounded.run(), /retry bound/);
  await assert.rejects(fixture(3, false).run(), /official image-offload/);
  await assert.rejects(fixture(1).run(), /newest image is preserved/);
  await assert.rejects(fixture(0).run(), /no older eligible image/);
});
test('does not intercept other routes or unrelated errors; new step resets bound', async () => {
  const f = fixture(5, true, 1);
  assert.equal(await f.run(failure(), {provider:'other'}), undefined);
  assert.equal(await f.run({code:'INVALID_REQUEST', message:'400 nope'}), undefined);
  assert.equal(f.decisions.length, 0);
  await f.run();
  assert.deepEqual(await f.run(failure(), {step:1}), {kind:'retry'});
});

test('installed pi-ai adapter HTTP mock -> real Cordis -> official offload', async () => {
  // Exercise the installed adapter's real stream translation and HTTP SDK.
  // The model registry is a minimal fixture; image persistence is exercised
  // through the official projection above, independently of attachment storage.
  const {streamSimple} = await import('@earendil-works/pi-ai/api/openai-completions');
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume(); requests++;
    if (requests <= 2) {
      res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify(body));
    } else {
      res.writeHead(200, {'content-type':'text/event-stream'});
      res.end('data: '+JSON.stringify({id:'mock', object:'chat.completion.chunk', choices:[{index:0, delta:{role:'assistant',content:'OK'}, finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'mock', object:'chat.completion.chunk', choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const model = {id:'arbitrary-vision-model', name:'Mock', provider:'ninfer', api:'openai-completions',
      baseUrl:`http://127.0.0.1:${server.address().port}/v1`, reasoning:false, input:['text','image'],
      contextWindow:10000, maxTokens:100, cost:{input:0, output:0, cacheRead:0, cacheWrite:0}};
    const profile = {piProvider:{}, modelErrors:new Map(), streamIdleTimeoutMs:10000};
    const adapter = new PiAiAdapter({resolveApiKey:async()=> 'mock'});
    const snapshot = {profiles:new Map([['ninfer', profile]]), models:{getModel:()=>model, streamSimple}};
    const f = fixture(3);
    for (let attempt = 0; attempt < 3; attempt++) {
      let terminal;
      for await (const chunk of adapter.streamWithSnapshot({provider:'ninfer', model:model.id,
        messages:[createUserMessage({content:[{type:'text',text:'mock request'}]})]}, snapshot)) {
        if (chunk.type === 'finish') terminal = chunk.reason;
      }
      if (attempt < 2) {
        assert.equal(terminal.kind, 'error');
        assert.equal(isVisionBudgetFailure(terminal.failure), true, JSON.stringify(terminal));
        assert.deepEqual(await f.run(terminal.failure), {kind:'retry'});
      } else assert.equal(terminal.kind, 'stop');
    }
    assert.equal(requests, 3);
    assert.equal(f.decisions.length, 2);
    await assert.rejects(f.run(), /no older eligible image/);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('retry without durable progress terminates immediately', async () => {
  const f = fixture(3, false);
  f.ctx.on('agent/request-error', async () => ({kind:'retry'}));
  await assert.rejects(f.run(), /did not omit exactly the oldest image/);
  assert.equal(f.decisions.length, 0);
});
test('already omitted images are skipped by the official selector', async () => {
  const f = fixture(4);
  await f.run();
  await f.run();
  assert.deepEqual(f.decisions.map(d=>d.data.targets[0].seq), [0,1]);
});
test('reject invalid configuration', () => {
  for (const config of [{providers:[]}, {providers:['ninfer'],maxRetries:0}, {providers:['ninfer'],maxRetries:Infinity}]) {
    assert.throws(()=>apply({on(){}},config));
  }
});

 test('GitHub bundle default needs no provider names', async () => {
  const f = fixture(3, false);
  // Capture the translated signal without claiming an omission happened.
  let translated;
  const ctx = new Context();
  ctx.on('agent/request-error', async payload => { translated = payload.failure; });
  assert.doesNotThrow(() => apply(ctx));
  await assert.rejects(ctx.waterfall('agent/request-error', {agent:f.agent, provider:'any-model-route',
    turn:1, step:0, failure:failure(), signal:new AbortController().signal}, async()=>undefined), /official image-offload/);
  assert.equal(translated.code, 'IMAGE_OFFLOAD_REQUIRED');
  assert.equal(translated.offloadImages, 1);
});

test('installed DSH accepts bundle metadata, patch and broad version requirements', async () => {
  const {readFileSync} = await import('node:fs');
  const {fileURLToPath} = await import('node:url');
  const {loadOverlayPatches, composeEntries, evaluatePluginCompatibility, bundlePatchPaths} = await import('@deepseek-ai/dsh-app-boot');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const [patch] = bundlePatchPaths(root, manifest.dsh.bundle);
  const entries = composeEntries([loadOverlayPatches('dsh', patch)]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, manifest.name);
  assert.equal(entries[0].config.maxRetries, 32);
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.2'), undefined);
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.2'), undefined);
  assert.equal(manifest.scripts.prepare, undefined);
  assert.equal(manifest.scripts.postinstall, undefined);
});
