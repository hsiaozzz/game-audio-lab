import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { directPrompt } from '../src/director.mjs';
import { canonicalJson, hashCanonical, normalizeGameBrief, createGameRevisionIdentity, validateGameAudioJoin, createAudioPlan, createAudioPackage, createGameAudioAdapter } from '../src/game-audio-pipeline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(root, 'artifacts/pipeline-validation.json');
const report = { createdAt: new Date().toISOString(), script: 'scripts/check-pipeline.mjs', purpose: 'Shared game/audio generation input, deterministic plan, version join, semantic event adapter and failure isolation integration checks.', caveat: 'Game generation is simulated by a small independent task. Runtime calls are mocked; no PCM is rendered and no subjective quality is inferred.', checks: [], pass: false };
const copy = value => JSON.parse(JSON.stringify(value));
const brief = { schemaVersion: 1, projectId: 'pipeline-integration-check', revision: 3, prompt: '温暖的海岛钓鱼游戏，有收集奖励和受伤反馈。', world: { dimension: '2d', mood: ['warm'] } };
const contract = { version: 2, events: [
  { id: 'ui.confirm', cue: 'ui', required: true, maxRatePerSecond: 4 },
  { id: 'item.collect', cue: 'collect', required: true, maxRatePerSecond: 4 },
  { id: 'bonus.collect', cue: 'collect', required: true, maxRatePerSecond: 4 },
  { id: 'player.hit', cue: 'hit', required: true, maxRatePerSecond: 2 },
  { id: 'quest.optional', required: false }
], sceneStates: ['menu', 'exploration', 'reward'] };

function mockRuntime() {
  const calls = [], events = [];
  const control = { failEvent: false, failPlay: false, failUnlock:false, budget: false };
  let contextState = 'uninitialized', playing = false, paused = false;
  return { calls, events, control,
    async unlock() { calls.push('unlock'); if(control.failUnlock)throw new Error('Simulated browser audio restriction'); contextState = 'running'; return contextState; },
    async play(rendered) { calls.push('play'); if (control.failPlay) throw new Error('Simulated music initialization failure'); assert.ok(rendered.score); playing = true; paused = false; return true; },
    async playEvent(cue, payload) { calls.push('playEvent'); if (control.failEvent) throw new Error('Simulated audio outage'); if (control.budget) return { accepted: false, reason: 'voice-budget' }; events.push({ cue, payload }); return { accepted: true, id: cue, source: 'mocked-runtime' }; },
    setIntensity(value) { calls.push('setIntensity'); return { intensity: value }; },
    pause() { calls.push('pause'); playing = false; paused = true; },
    async resume() { calls.push('resume'); playing = true; paused = false; return true; },
    stop() { calls.push('stop'); playing = false; paused = false; },
    async dispose() { calls.push('dispose'); contextState = 'closed'; playing = false; },
    getState() { return { contextState, playing, paused }; }
  };
}

try {
  const first = await createAudioPlan(brief, contract, { seed: 1701 });
  const reorderedBrief = { world: { mood: ['warm'], dimension: '2d' }, prompt: ` ${brief.prompt}\r\n`, revision: 3, projectId: brief.projectId, schemaVersion: 1 };
  const reorderedContract = { sceneStates: [...contract.sceneStates].reverse(), events: [...contract.events].reverse(), version: 2 };
  const repeated = await createAudioPlan(reorderedBrief, reorderedContract, { seed: 1701 });
  assert.equal(canonicalJson(first), canonicalJson(repeated));
  assert.equal(await hashCanonical(normalizeGameBrief(brief)), createHash('sha256').update(canonicalJson(normalizeGameBrief(brief))).digest('hex'));
  assert.equal(first.director.kind, 'local-rule-based-research-prototype'); assert.equal(first.director.modelConnected, false);
  assert.equal(first.bindings['bonus.collect'].cue, first.bindings['item.collect'].cue);
  assert.equal(first.bindings['world.step'], undefined); assert.equal(first.score.brief.eventBindings['world.step'], undefined);
  assert.notEqual((await createAudioPlan(brief, contract, { seed: 1702 })).planId, first.planId);
  assert.notEqual((await createAudioPlan({ ...brief, world: { ...brief.world, dimension: '3d' } }, contract, { seed: 1701 })).briefHash, first.briefHash);
  report.checks.push('canonical SHA-256 matches Node crypto', 'same normalized shared input gives identical plan', 'seed changes plan', 'extra shared world metadata affects brief hash', 'local director is labeled honestly', 'canonical cue reuse is allowed', 'profile event aliases never leak into explicit bindings');

  const duplicate = copy(contract); duplicate.events.push(copy(duplicate.events[0]));
  await assert.rejects(() => createAudioPlan(brief, duplicate), /Duplicate event/);
  const missing = copy(contract); delete missing.events[0].cue;
  await assert.rejects(() => createAudioPlan(brief, missing), /Required event/);
  const unknown = copy(contract); unknown.events[0].cue = 'shoot';
  await assert.rejects(() => createAudioPlan(brief, unknown), /Unknown cue/);
  const badRate = copy(contract); badRate.events[0].maxRatePerSecond = 0;
  await assert.rejects(() => createAudioPlan(brief, badRate), /maxRatePerSecond/);
  await assert.rejects(() => createAudioPlan({ ...brief, revision: 0 }, contract), /revision/);
  await assert.rejects(() => createAudioPlan({ ...brief, eventContractVersion:1 }, contract), /eventContractVersion/);
  await assert.rejects(() => createAudioPlan(brief, contract, { seed: NaN }), /seed/);
  await assert.rejects(() => createAudioPlan(brief, contract, { director: async () => ({ style: 'unvalidated-model-output' }) }), /Director output/);
  report.checks.push('duplicate semantic events rejected', 'required mappings enforced', 'unknown cue aliases rejected', 'rate/revision/seed bounds validated', 'conflicting brief/contract versions rejected', 'injected director output is validated');

  let releaseAudio;
  const audioGate = new Promise(resolve => { releaseAudio = resolve; });
  const audioTask = createAudioPlan(brief, contract, { seed: 1701, director: async (...args) => { await audioGate; return directPrompt(...args); } });
  async function generateGame(sharedBrief, sharedContract) {
    const identity = await createGameRevisionIdentity(sharedBrief, sharedContract);
    let score = 0;
    return { status: 'ready', ...identity, collect() { return ++score; }, get score() { return score; } };
  }
  const game = await generateGame(brief, contract); game.collect();
  assert.equal(game.status, 'ready'); assert.equal(game.score, 1);
  releaseAudio(); const audio = await audioTask;
  assert.deepEqual(validateGameAudioJoin(game, audio), { accepted: true });
  assert.equal(validateGameAudioJoin(await createGameRevisionIdentity({ ...brief, revision: 4 }, contract), audio).reason, 'stale-revision');
  assert.equal(validateGameAudioJoin(await createGameRevisionIdentity(brief, { ...contract, version: 3 }), audio).reason, 'contract-version-mismatch');
  const changedBinding = copy(contract); changedBinding.events.find(event => event.id === 'player.hit').cue = 'explosion';
  assert.equal(validateGameAudioJoin(await createGameRevisionIdentity(brief, changedBinding), audio).reason, 'contract-mismatch');
  const failedAudio = createAudioPlan(brief, contract, { director: async () => { throw new Error('Director is unavailable'); } }).then(() => 'unexpected-success', () => 'failed');
  const independentGame = await generateGame(brief, contract); independentGame.collect();
  assert.equal(await failedAudio, 'failed'); assert.equal(independentGame.status, 'ready'); assert.equal(independentGame.score, 1);
  report.checks.push('game becomes ready while audio generation waits', 'independent game/audio tasks join by exact shared version', 'stale revision cannot join', 'contract version and binding changes invalidate join', 'failed audio generation does not block game generation');

  let now = 0;
  const runtime = mockRuntime();
  const adapter = createGameAudioAdapter({ plan: first, runtime, clock: () => now, onError() { throw new Error('A broken observer must also be isolated'); } });
  assert.equal(runtime.calls.length, 0);
  const rendered = { score: first.score, buffer: { mock: true }, stats: { mode: 'hybrid' } };
  assert.equal((await adapter.start(rendered)).reason, 'locked'); assert.equal((await adapter.emit('item.collect')).reason, 'locked');
  assert.equal(runtime.calls.length, 0); assert.equal((await adapter.unlock()).accepted, true);
  runtime.control.failPlay=true;assert.equal((await adapter.start(rendered)).reason,'runtime-error');runtime.control.failPlay=false;
  assert.equal((await adapter.start(rendered)).accepted, true); assert.equal(adapter.getState().status, 'playing');
  const oldRendered = copy(rendered); oldRendered.score.pipeline.revision--;
  assert.equal((await adapter.start(oldRendered)).reason, 'stale-revision');
  const wrongVersion = copy(rendered); wrongVersion.score.pipeline.compilerVersion = 'future-incompatible';
  assert.equal((await adapter.start(wrongVersion)).reason, 'audio-version-mismatch');
  const mutatedScore = copy(rendered); mutatedScore.score.tracks[0].events[0].midi++;
  assert.equal((await adapter.start(mutatedScore)).reason, 'score-mismatch');
  assert.equal((await adapter.emit('fake.hit')).reason, 'unknown-event');
  assert.equal((await adapter.emit('quest.optional')).reason, 'unmapped-optional-event');
  for (const payload of [{ strength: NaN }, { pan: Infinity }, { strength: 2 }, { pan: -2 }]) assert.equal((await adapter.emit('player.hit', payload)).reason, 'invalid-payload');
  assert.equal((await adapter.emit('player.hit', { revision: 2 })).reason, 'stale-revision');
  assert.equal((await adapter.emit('player.hit', { position: { x: 0, y: 0, z: 0 } })).reason, 'unsupported-spatial-payload');
  assert.equal((await adapter.emit('player.hit', { strength: .75, pan: -.5 })).accepted, true);
  assert.deepEqual(runtime.events.at(-1), { cue: 'hit', payload: { strength: .75, pan: -.5 } });
  assert.equal((await adapter.emit('player.hit')).reason, 'rate-limited'); now = .5;
  assert.equal((await adapter.emit('player.hit')).accepted, true);
  const concurrent = await Promise.all([adapter.emit('item.collect'), adapter.emit('item.collect')]);
  assert.equal(concurrent.filter(result => result.accepted).length, 1); assert.equal(concurrent.filter(result => result.reason === 'rate-limited').length, 1);
  assert.equal((await adapter.emit('bonus.collect')).accepted, true);
  report.checks.push('adapter constructs no context and never autoplays', 'explicit unlock/start gates playback', 'rendered score identity/compiler/content is checked', 'unknown and unmapped events never fall back to beeps', 'payload finite ranges and stale event versions checked', '3D positioning is not falsely claimed', 'semantic event maps to the exact canonical cue', 'per-event frequency and concurrent rate reservations enforced', 'shared cue events keep independent rate limits');

  runtime.control.budget = true; now = 1;
  assert.equal((await adapter.emit('player.hit')).reason, 'voice-budget');
  runtime.control.budget = false; assert.equal((await adapter.emit('player.hit')).accepted, true);
  runtime.control.failEvent = true; now = 2; game.collect();
  const failedEvent = await adapter.emit('item.collect');
  assert.equal(failedEvent.accepted, false); assert.equal(failedEvent.reason, 'runtime-error'); assert.equal(game.score, 2);
  runtime.control.failEvent = false; assert.equal((await adapter.emit('item.collect')).accepted, true);
  assert.equal(adapter.setScene('exploration').accepted, true); assert.equal(adapter.setScene('unregistered-scene').reason, 'unknown-scene');
  assert.equal(adapter.setIntensity(.8).accepted, true); assert.equal(adapter.setIntensity(NaN).reason, 'invalid-intensity');
  assert.equal(adapter.pause().accepted, true); assert.equal((await adapter.emit('item.collect')).reason, 'paused');
  assert.equal((await adapter.resume()).accepted, true); assert.equal(adapter.stop().accepted, true);
  const pendingStart=adapter.start(rendered);adapter.stop();assert.equal((await pendingStart).reason,'cancelled');
  await adapter.dispose(); await adapter.dispose();
  assert.equal(runtime.calls.filter(call => call === 'dispose').length, 1); assert.equal((await adapter.emit('ui.confirm')).reason, 'disposed');
  const rejectedRuntime = mockRuntime(), invalidAdapter = createGameAudioAdapter({ plan: { ...first, compilerVersion: 'future-incompatible' }, runtime: rejectedRuntime });
  assert.equal((await invalidAdapter.unlock()).reason, 'invalid-plan'); assert.equal(rejectedRuntime.calls.length, 0);
  const restrictedRuntime=mockRuntime();restrictedRuntime.control.failUnlock=true;const restrictedAdapter=createGameAudioAdapter({plan:first,runtime:restrictedRuntime});assert.equal((await restrictedAdapter.unlock()).reason,'runtime-error');assert.equal((await restrictedAdapter.start(rendered)).reason,'locked');await restrictedAdapter.dispose();
  report.checks.push('runtime voice-budget rejection is preserved', 'failed sound attempts do not consume event cooldown', 'audio failure and broken error observer cannot break a game callback', 'music initialization failure is isolated', 'explicit scene/intensity controls', 'pause/resume/stop/dispose lifecycle', 'stop cancels pending package start', 'browser unlock failure remains explicit and locked', 'unsupported plan version is safely disabled');

  const sourcePackage = createAudioPackage(first), roundTrip = JSON.parse(JSON.stringify(sourcePackage));
  assert.equal(roundTrip.manifest.mediaStatus, 'not-rendered'); assert.deepEqual(roundTrip.manifest.files, []);
  assert.equal(roundTrip.manifest.qualityStatus, 'not-rendered-not-evaluated');
  for (const source of roundTrip.manifest.runtimeSources) await fs.access(path.join(root, source.module));
  assert.equal(roundTrip.manifest.soundBank.contentHash, null);
  assert.equal(roundTrip.plan.scoreHash, first.scoreHash);
  report.checks.push('serializable AudioPackage honestly remains source-only', 'runtime source paths exist on disk', 'no fictitious audio files or asset digests');
  report.identity = await createGameRevisionIdentity(brief, contract);
  report.plan = { planId: first.planId, scoreHash: first.scoreHash, compilerVersion: first.compilerVersion, soundBankVersion: first.soundBankVersion, bindingCount: Object.keys(first.bindings).length, unmappedOptionalEvents: first.unmappedOptionalEvents, mediaStatus: first.mediaStatus };
  report.gameState = { initialGameScore: 1, afterAudioFailureGameScore: game.score, independentGameSurvivedAudioGenerationFailure: independentGame.status === 'ready' };
  report.pass = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ reportPath, ...report }, null, 2));
