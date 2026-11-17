import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAudioJobStore } from '../server/audio-jobs.mjs';
import { createDeliveryPlan, digest } from '../server/audio-plan.mjs';
import { createAudioServiceClient } from '../src/audio-service-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = path.resolve(os.tmpdir()), data = await fs.mkdtemp(path.join(temporaryRoot, 'game-audio-jobs-'));
const owner = 'listener-a', other = 'listener-b', options = key => ({ owner, idempotencyKey: key });
const checks = [], stores = new Set(), calls = new Map(), gates = new Map(), failures = new Set();
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
let child;
const now = () => Date.now();
async function until(callback, message, timeout = 6000) {
  const limit = now() + timeout;
  while (now() < limit) { const value = await callback(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out: ' + message);
}
const pendingGate = id => { let resolve; const promise = new Promise(done => { resolve = done; }); gates.set(id, { promise, resolve }); return resolve; };
async function renderer({ plan, item, directory, signal }) {
  calls.set(item.id, (calls.get(item.id) || 0) + 1);
  const gate = gates.get(item.id);
  if (gate) await new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    gate.promise.then(resolve).finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  if (failures.has(item.id)) throw Object.assign(new Error('Intentional transient fake renderer error'), { code: 'fake_render_failure', retryable: true });
  const files = [], count = item.kind === 'sfx' ? item.variants : item.playback === 'stems' ? 3 : 1;
  for (let index = 0; index < count; index++) {
    const filename = `variant-${index + 1}.${item.formatId === 'opus-ogg' ? 'ogg' : 'm4a'}`;
    const bytes = Buffer.from(`FAKE AUDIO CONTRACT FIXTURE ${item.id} ${index} ${plan.sourcePlan.seed}`);
    await fs.writeFile(path.join(directory, filename), bytes);
    files.push({ id: `${item.id}:${index}`, path: filename, sha256: hashBytes(bytes), bytes: bytes.length,
      mimeType: item.formatId === 'opus-ogg' ? 'audio/ogg; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"',
      formatId: item.formatId, container: item.formatId === 'opus-ogg' ? 'ogg' : 'mp4', codec: item.formatId === 'opus-ogg' ? 'opus' : 'aac-lc',
      sampleRate: item.sampleRate, channels: item.channels, frames: 4800, decodedPcmBytes: 4800 * item.channels * 4,
      encoding: { encoder: 'fake-contract-test', version: '1', targetBitrateKbps: item.bitrateKbps, rateControl: 'vbr' } });
  }
  return { cacheKey: `fake-${item.id}`, files,
    ...(item.kind === 'sfx' ? { sfx: { eventId: item.eventId, variants: files.map(file => file.id) } } : { music: { scene: item.scene, gainDb: 0, loop: { enabled: true, referenceSampleRate: 48000, startFrame: 0, endFrame: 4800 }, ...(item.playback === 'mix' ? { mixFileId: files[0].id } : { stemFileIds: files.map(file => file.id) }) } }),
    provenance: { rendererVersion: 'fake-contract-test-v1', assets: [] }, quality: { technical: 'passed', binding: 'contract-validated', listening: 'not-evaluated' } };
}
async function open(directory, extra = {}) { const store = await createAudioJobStore({ dataDir: directory, renderItem: renderer, ...extra }); stores.add(store); return store; }
async function close(store) { await store.close(); stores.delete(store); }
function request(plan, selected = plan.items.map(item => item.id)) { return { planId: plan.planId, planDigest: plan.planDigest, identity: plan.identity, acceptedItems: selected, delivery: plan.delivery }; }
async function finish(store, id) { return until(async () => { const job = await store.getJob(id, { owner }); return ['ready', 'partial-ready', 'failed', 'cancelled'].includes(job.status) && job; }, 'job completion'); }
function reSign(plan, changes) { const { planId, planDigest, status, ...core } = { ...structuredClone(plan), ...changes }; const next = digest(core); return { ...core, planId: 'plan-' + next, planDigest: next, status: 'awaiting-confirmation' }; }
const input = {
  gameBrief: { schemaVersion: 1, projectId: 'store-contract-check', revision: 1, prompt: 'cozy warm island collecting game' },
  eventContract: { version: 1, sceneStates: ['exploration'], events: [{ id: 'item.collect', cue: 'collect', required: true }, { id: 'player.hit', cue: 'hit' }, { id: 'unused.laser', cue: 'laser' }] },
  audioRequests: [{ id: 'sfx.collect', kind: 'sfx', eventId: 'item.collect' }, { id: 'sfx.hit', kind: 'sfx', eventId: 'player.hit' }, { id: 'sfx.unused', kind: 'sfx', eventId: 'unused.laser' }, { id: 'bgm.loop', kind: 'music', scene: 'exploration', required: false }]
};
try {
  const plan = await createDeliveryPlan(input), selected = ['sfx.collect', 'sfx.hit', 'bgm.loop'], body = request(plan, selected);
  let store = await open(path.join(data, 'main'));
  await store.savePlan(plan, { owner });
  await assert.rejects(() => store.getPlan(plan.planId, { owner: other }), error => error.status === 404);
  await assert.rejects(() => store.getPlan(plan.planId), error => error.status === 401);
  await assert.rejects(() => store.savePlan({ ...plan, sourcePlan: {} }, { owner }), error => error.status === 409);
  checks.push('plan ownership, immutable digest and missing credentials are checked');
  await assert.rejects(() => store.createJob({ ...body, planDigest: '0'.repeat(64) }, options('invalid-digest')), error => error.status === 409);
  await assert.rejects(() => store.createJob({ ...body, identity: { ...body.identity, revision: 2 } }, options('invalid-revision')), error => error.status === 409);
  await assert.rejects(() => store.createJob({ ...body, delivery: { ...body.delivery, quality: 'high' } }, options('invalid-delivery')), error => error.status === 409);
  await assert.rejects(() => store.createJob(request(plan, ['bgm.loop']), options('missing-required')), error => error.status === 400);
  checks.push('confirmation checks exact digest, shared identity, delivery and required coverage');
  failures.add('sfx.hit'); const release = pendingGate('bgm.loop');
  const [created, replay] = await Promise.all([store.createJob(body, options('first')), store.createJob({ ...body, acceptedItems: [...selected].reverse() }, options('first'))]);
  assert.equal(created.replayed, false); assert.equal(replay.replayed, true); assert.equal(created.job.id, replay.job.id);
  const canonicalSelection = digest({ planDigest: plan.planDigest, acceptedItems: [...selected].sort(), delivery: plan.delivery });
  assert.equal(created.job.selectionDigest, canonicalSelection);
  await assert.rejects(() => store.createJob(request(plan, ['sfx.collect']), options('first')), error => error.status === 409);
  await assert.rejects(() => store.getJob(created.job.id, { owner: other }), error => error.status === 404);
  checks.push('concurrent idempotency replays one durable job and rejects changed selections');
  const partial = await until(async () => { const job = await store.getJob(created.job.id, { owner }); return job.status === 'rendering' && job.packageId && job.components.find(item => item.id === 'bgm.loop').status === 'rendering' && job; }, 'partial SFX package while music waits');
  assert.equal(partial.requiredReady, true); assert.equal(partial.allSelectedReady, false);
  const firstPackage = await store.getPackage(partial.packageId, { owner }), firstManifestText = JSON.stringify(firstPackage.manifest);
  assert.deepEqual(firstPackage.manifest.deliveredItems, ['sfx.collect']); assert.equal(firstPackage.manifest.files.filter(file => file.mimeType.startsWith('audio/')).length, 1);
  assert.equal(firstPackage.manifest.files.filter(file => file.kind === 'provenance').length, 2);
  const { packageId, ...manifestCore } = firstPackage.manifest; assert.equal(digest(manifestCore), packageId);
  assert.equal(JSON.stringify(firstPackage.manifest).includes(path.resolve(data)), false);
  for (const file of firstPackage.manifest.files) { const bytes = await fs.readFile(path.join(firstPackage.directory, file.path)); assert.equal(bytes.length, file.bytes); assert.equal(hashBytes(bytes), file.sha256); }
  await assert.rejects(() => store.getPackage(partial.packageId, { owner: other }), error => error.status === 404);
  checks.push('SFX-first rendering publishes an immutable owner-isolated partial package with real file hashes and licenses');
  release(); gates.delete('bgm.loop'); const incomplete = await finish(store, created.job.id);
  assert.equal(incomplete.status, 'partial-ready'); assert.equal(incomplete.requiredReady, true); assert.equal(incomplete.allSelectedReady, false);
  assert.equal(incomplete.components.find(item => item.id === 'sfx.hit').error.retryable, true);
  assert.equal(calls.has('sfx.unused'), false);
  checks.push('only selected media is rendered and optional failures remain explicit partial-ready');
  failures.delete('sfx.hit');
  const retried = await store.retryJob(incomplete.id, { ...body, retryItems: ['sfx.hit'] }, options('retry'));
  const complete = await finish(store, retried.job.id);
  assert.equal(complete.status, 'ready'); assert.equal(complete.retryOf, incomplete.id); assert.equal(complete.requiredReady, true); assert.equal(complete.allSelectedReady, true);
  assert.equal(calls.get('sfx.collect'), 1); assert.equal(calls.get('bgm.loop'), 1); assert.equal(calls.get('sfx.hit'), 2);
  assert.equal(JSON.stringify((await store.getPackage(firstPackage.manifest.packageId, { owner })).manifest), firstManifestText);
  const fullPackage = await store.getPackage(complete.packageId, { owner });
  assert.equal(fullPackage.manifest.budget.transferBytes, fullPackage.manifest.files.reduce((sum, file) => sum + file.bytes, 0));
  assert.equal(fullPackage.manifest.budget.decodedPcmBytes, fullPackage.manifest.files.reduce((sum, file) => sum + file.decodedPcmBytes, 0));
  checks.push('retry creates a new job, retains ready components and preserves already issued manifests');
  const cached = await store.createJob(body, options('cached'));
  const cachedComplete = await finish(store, cached.job.id);
  assert.equal(cachedComplete.status, 'ready'); assert.equal(cachedComplete.components.every(item => item.cacheHit), true);
  assert.equal(calls.get('sfx.collect'), 1); assert.equal(calls.get('sfx.hit'), 2); assert.equal(cachedComplete.packageId, complete.packageId);
  checks.push('verified per-item cache avoids rerendering and preserves stable package identity');
  await assert.rejects(() => createAudioJobStore({ dataDir: path.join(data, 'main'), renderItem: renderer }), error => error.status === 503 && error.code === 'store_in_use');
  await close(store);
  const legacyJobPath = path.join(data, 'main', 'owners', hashBytes(owner), 'jobs', `${complete.id}.json`);
  const legacyJob = JSON.parse(await fs.readFile(legacyJobPath, 'utf8')); delete legacyJob.publishedItemIds;
  await fs.writeFile(legacyJobPath, JSON.stringify(legacyJob));
  store = await open(path.join(data, 'main'));
  assert.equal((await store.getJob(complete.id, { owner })).status, 'ready');
  assert.equal((await store.getJob(complete.id, { owner })).allSelectedReady, true);
  assert.equal((await store.getJob(complete.id, { owner })).requiredReady, true);
  assert.equal((await store.createJob(body, options('first'))).job.id, created.job.id);
  assert.equal((await store.getPackage(complete.packageId, { owner })).manifest.packageId, complete.packageId);
  checks.push('exclusive process lock, restart persistence, legacy publication restored from manifest and reconstructed idempotency index');
  const otherPlan = await createDeliveryPlan({ ...input, gameBrief: { ...input.gameBrief, projectId: 'other-project' } }); await store.savePlan(otherPlan, { owner });
  const otherProjectJob = await store.createJob(request(otherPlan, ['sfx.collect']), options('first'));
  assert.notEqual(otherProjectJob.job.id, created.job.id); await finish(store, otherProjectJob.job.id);
  checks.push('idempotency keys are independently scoped to owner and project');
  const cancelPlan = await createDeliveryPlan({ ...input, gameBrief: { ...input.gameBrief, projectId: 'cancel-project' } }); await store.savePlan(cancelPlan, { owner });
  pendingGate('sfx.collect');
  const cancelling = await store.createJob(request(cancelPlan, ['sfx.collect']), options('cancel'));
  await until(async () => (await store.getJob(cancelling.job.id, { owner })).components[0].status === 'rendering', 'cancellable renderer start');
  const cancelled = await store.cancelJob(cancelling.job.id, { owner }); assert.equal(cancelled.status, 'cancelled');
  assert.equal((await store.cancelJob(cancelling.job.id, { owner })).status, 'cancelled');
  gates.get('sfx.collect').resolve(); gates.delete('sfx.collect');
  const cancelledRetry = await store.retryJob(cancelled.id, request(cancelPlan, ['sfx.collect']), options('cancel-retry'));
  assert.equal((await finish(store, cancelledRetry.job.id)).status, 'ready');
  checks.push('cancellation aborts active work and retry creates an independent recoverable job');
  // Hold the real package-directory rename after rendering is ready. No timing
  // assumption or audio rendering is used: publication itself remains pending.
  const publishing = await open(path.join(data, 'publication'));
  async function checkPublicationWindow(plan, publicationNumber, key) {
    await publishing.savePlan(plan, { owner });
    const originalRename = fs.rename;
    let releasePublication, signalPublication, publicationCount = 0, released = false, client;
    const publicationGate = new Promise(resolve => { releasePublication = () => { released = true; resolve(); }; });
    const publicationReached = new Promise(resolve => { signalPublication = resolve; });
    fs.rename = async (from, to) => {
      if (/[\\/]packages[\\/][a-f0-9]{64}$/.test(String(to)) && ++publicationCount === publicationNumber) { signalPublication(); await publicationGate; }
      return originalRename(from, to);
    };
    try {
      const result = await publishing.createJob(request(plan), options(key));
      await Promise.race([publicationReached, until(() => released, 'publication gate', 6000)]);
      const before = await publishing.getJob(result.job.id, { owner });
      assert.equal(before.progress.ready, plan.items.length, 'Render progress can be complete before publication');
      assert.equal(before.components.every(item => item.status === 'ready'), true);
      assert.equal(before.requiredReady, false, 'Required readiness must describe the published package');
      assert.equal(before.allSelectedReady, false, 'All-selected readiness must describe the published package');
      assert.equal(Object.hasOwn(before, 'publishedItemIds'), false, 'Internal publication coverage is not part of the wire job');
      if (publicationNumber === 1) assert.equal(before.manifestUrl, null);
      else {
        assert(before.packageId && before.manifestUrl);
        const partial = (await publishing.getPackage(before.packageId, { owner })).manifest;
        assert.equal(partial.deliveredItems.length, plan.items.length - 1);
        assert.equal(partial.allSelectedReady, false);
      }
      client = createAudioServiceClient({ baseUrl: 'http://publication.fixture', fetchImpl: async () => new Response(JSON.stringify({ job: await publishing.getJob(result.job.id, { owner }) }), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
      let finished = false, polls = 0;
      const waiting = client.waitForJob(result.job.id, { intervalMs: 1, timeoutMs: 6000, onUpdate: () => { polls++; } }).then(job => { finished = true; return job; });
      await until(() => polls >= 3 || finished, 'SDK polling during publication');
      assert.equal(finished, false, 'SDK waitForJob must not return an absent or old partial manifest');
      releasePublication();
      const ready = await waiting;
      assert.equal(ready.requiredReady, true); assert.equal(ready.allSelectedReady, true);
      assert(ready.manifestUrl && ready.packageId);
      const manifest = (await publishing.getPackage(ready.packageId, { owner })).manifest;
      assert.deepEqual(manifest.deliveredItems, [...ready.acceptedItems].sort());
      assert.equal(manifest.requiredReady, true); assert.equal(manifest.allSelectedReady, true);
      await finish(publishing, ready.id);
    } finally { releasePublication(); fs.rename = originalRename; await client?.dispose(); }
  }
  const oneSfxPlan = await createDeliveryPlan({ ...input, gameBrief: { ...input.gameBrief, projectId: 'publish-single-sfx' }, audioRequests: [input.audioRequests[0]] });
  await checkPublicationWindow(oneSfxPlan, 1, 'publication-single');
  const finalMusicPlan = await createDeliveryPlan({ ...input, gameBrief: { ...input.gameBrief, projectId: 'publish-final-music' }, audioRequests: [input.audioRequests[0], { ...input.audioRequests[3], required: true }] });
  await checkPublicationWindow(finalMusicPlan, 2, 'publication-music');
  await close(publishing);
  checks.push('published readiness and SDK polling wait for atomic single-SFX publication and final-BGM replacement of an older partial package');
  for (const budget of ['maxTransferBytes', 'maxDecodedPcmBytes']) {
    const low = reSign(plan, { delivery: { ...plan.delivery, [budget]: 1 } }); await store.savePlan(low, { owner });
    const bounded = await store.createJob(request(low, ['sfx.collect']), options('budget-' + budget)), finished = await finish(store, bounded.job.id);
    assert.equal(finished.status, 'failed'); assert.equal(finished.packageId, null); assert.equal(finished.components[0].error.retryable, false);
    assert.equal(finished.components[0].error.code, budget === 'maxTransferBytes' ? 'transfer_budget_exceeded' : 'decoded_budget_exceeded');
  }
  checks.push('measured encoded/provenance bytes and decoded PCM enforce separate hard budgets');
  await close(store);
  const pressure = await open(path.join(data, 'pressure'), { maxQueuedPerOwner: 1, maxQueued: 2 }); await pressure.savePlan(plan, { owner });
  pendingGate('sfx.collect'); const waiting = await pressure.createJob(request(plan, ['sfx.collect']), options('pressure-1'));
  await assert.rejects(() => pressure.createJob(request(plan, ['sfx.collect']), options('pressure-2')), error => error.status === 429 && error.retryable);
  assert.equal((await pressure.createJob(request(plan, ['sfx.collect']), options('pressure-1'))).job.id, waiting.job.id);
  await pressure.savePlan(plan, { owner: other }); const otherQueued = await pressure.createJob(request(plan, ['sfx.collect']), { owner: other, idempotencyKey: 'other-queue' });
  await pressure.savePlan(plan, { owner: 'third-owner' });
  await assert.rejects(() => pressure.createJob(request(plan, ['sfx.collect']), { owner: 'third-owner', idempotencyKey: 'global-capacity' }), error => error.status === 429);
  await pressure.cancelJob(otherQueued.job.id, { owner: other });
  await pressure.cancelJob(waiting.job.id, { owner }); gates.get('sfx.collect').resolve(); gates.delete('sfx.collect'); await close(pressure);
  checks.push('queue backpressure rejects new work while allowing idempotent replay');
  const recoveryData = path.join(data, 'crash-recovery'), childFile = path.join(data, 'crash-worker.mjs');
  await fs.writeFile(path.join(data, 'recovery-plan.json'), JSON.stringify(plan));
  await fs.writeFile(childFile, `import fs from 'node:fs/promises';\nimport {createAudioJobStore} from ${JSON.stringify(pathToFileURL(path.join(root, 'server/audio-jobs.mjs')).href)};\nconst plan=JSON.parse(await fs.readFile(${JSON.stringify(path.join(data, 'recovery-plan.json'))},'utf8'));\nconst store=await createAudioJobStore({dataDir:${JSON.stringify(recoveryData)},renderItem:async()=>{console.log('RENDERING');return new Promise(()=>{});}});\nawait store.savePlan(plan,{owner:${JSON.stringify(owner)}});\nconst result=await store.createJob(${JSON.stringify(request(plan, ['sfx.collect']))},{owner:${JSON.stringify(owner)},idempotencyKey:'crash'});\nconsole.log(JSON.stringify({id:result.job.id}));\nsetInterval(()=>{},1000);\n`);
  child = spawn(process.execPath, [childFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  const crashed = await until(() => { try { return output.includes('RENDERING') && JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('{'))); } catch { return null; } }, 'crash fixture active renderer');
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; child = null;
  const recovered = await open(recoveryData), recoveredJob = await finish(recovered, crashed.id);
  assert.equal(recoveredJob.status, 'ready'); assert.ok(recoveredJob.recoveredAt);
  assert.equal((await recovered.createJob(request(plan, ['sfx.collect']), options('crash'))).job.id, crashed.id); await close(recovered);
  checks.push('a killed worker leaves a stale PID lock and unfinished job that restart safely requeues');
  console.log(JSON.stringify({ pass: true, purpose: 'Persistent queue contracts with fake media; no actual audio-quality claim', checks }, null, 2));
} finally {
  if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
  for (const store of stores) await store.close();
  if (path.dirname(path.resolve(data)) !== temporaryRoot || !path.basename(data).startsWith('game-audio-jobs-')) throw new Error('Unexpected test directory');
  await fs.rm(data, { recursive: true, force: true });
}
