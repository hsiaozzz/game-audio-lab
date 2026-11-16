import { directPrompt } from './director.mjs';
import { composeScore } from './composer.mjs';

export const PIPELINE_VERSIONS = Object.freeze({ schema: 1, compiler: 'game-audio-pipeline-v1', composer: 'seeded-phrase-composer-v1', director: 'local-keyword-profiles-v1', runtime: 'web-audio-runtime-v2', soundBank: 'prepared-research-bank-2026-11-16-v1', soundBankManifestSchema: 1, tone: '15.1.22' });
export const SUPPORTED_CUES = Object.freeze(['ui', 'collect', 'cast', 'splash', 'footstep', 'footstepWood', 'hit', 'laser', 'charge', 'explosion', 'victory', 'failure']);
const cueSet = new Set(SUPPORTED_CUES);
const identityKeys = ['projectId', 'revision', 'briefHash', 'contractVersion', 'contractHash'];
const clone = value => JSON.parse(canonicalJson(value));
const record = value => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, name, limit = 10000) => { if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new TypeError(`${name} must be a nonempty string of at most ${limit} characters`); return value.replace(/\r\n?/g, '\n').trim().normalize('NFC'); };
const positiveVersion = (value, name) => { if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`); return value; };
const deepFreeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); } return value; };

/** Sorted JSON, preserving array order. Unsupported JSON values fail explicitly. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  throw new TypeError('Pipeline values must contain finite, plain JSON data');
}

export async function hashCanonical(value) {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 requires Web Crypto (localhost/HTTPS or Node 20+)');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizeGameBrief(input) {
  if (!record(input) || input.schemaVersion !== 1) throw new TypeError('GameBrief schemaVersion must be 1');
  const brief = clone(input);
  if (brief.revision !== undefined && brief.briefRevision !== undefined && brief.revision !== brief.briefRevision) throw new TypeError('Conflicting revision and briefRevision');
  brief.projectId = text(brief.projectId, 'projectId', 128);
  brief.revision = positiveVersion(brief.revision ?? brief.briefRevision, 'revision');
  delete brief.briefRevision;
  brief.prompt = text(brief.prompt, 'prompt');
  return brief;
}

export function normalizeEventContract(input) {
  if (!record(input) || !Array.isArray(input.events)) throw new TypeError('GameEventContract.events is required');
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new TypeError('GameEventContract schemaVersion must be 1');
  const contract = clone(input), seen = new Set();
  contract.schemaVersion = 1; contract.version = positiveVersion(contract.version, 'contract.version');
  contract.events = contract.events.map(event => {
    if (!record(event)) throw new TypeError('Each event must be a plain JSON object');
    const id = text(event.id, 'event.id', 128);
    if (!/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(id)) throw new TypeError('Invalid semantic event ID: ' + id);
    if (seen.has(id)) throw new TypeError('Duplicate event ID: ' + id); seen.add(id);
    if (event.required !== undefined && typeof event.required !== 'boolean') throw new TypeError('event.required must be boolean');
    const cue = event.cue == null ? null : text(event.cue, 'event.cue', 32);
    if (cue !== null && !cueSet.has(cue)) throw new TypeError('Unknown cue: ' + cue);
    if (event.required === true && cue === null) throw new TypeError('Required event lacks a cue mapping: ' + id);
    const rate = event.maxRatePerSecond ?? null;
    if (rate !== null && (!Number.isFinite(rate) || rate <= 0 || rate > 1000)) throw new TypeError('maxRatePerSecond must be positive and no greater than 1000');
    return { ...event, id, cue, required: event.required === true, maxRatePerSecond: rate };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (contract.sceneStates !== undefined && !Array.isArray(contract.sceneStates)) throw new TypeError('sceneStates must be an array');
  const states = (contract.sceneStates || []).map(value => text(value, 'scene state', 128));
  if (new Set(states).size !== states.length) throw new TypeError('Duplicate scene state');
  contract.sceneStates = states.sort();
  return contract;
}

/** Both generators can independently compute this identity from their shared input. */
export async function createGameRevisionIdentity(brief, eventContract) {
  const normalizedBrief = normalizeGameBrief(brief), contract = normalizeEventContract(eventContract);
  if(normalizedBrief.eventContractVersion!==undefined&&normalizedBrief.eventContractVersion!==contract.version)throw new TypeError('GameBrief eventContractVersion differs from the shared contract');
  return { projectId: normalizedBrief.projectId, revision: normalizedBrief.revision, briefHash: await hashCanonical(normalizedBrief), contractVersion: contract.version, contractHash: await hashCanonical(contract) };
}

/** A join check, not a game generator. A stale task must not overwrite current work. */
export function validateGameAudioJoin(gameIdentity, audioIdentity) {
  const reasons = { projectId: 'project-mismatch', revision: 'stale-revision', briefHash: 'brief-mismatch', contractVersion: 'contract-version-mismatch', contractHash: 'contract-mismatch' };
  for (const key of identityKeys) if (gameIdentity?.[key] === undefined || audioIdentity?.[key] === undefined || gameIdentity[key] !== audioIdentity[key]) return { accepted: false, reason: reasons[key], field: key };
  return { accepted: true };
}

/** No network/model dependency. A trusted future director can be injected explicitly. */
export async function createAudioPlan(gameBrief, eventContract, options = {}) {
  if (!record(options)) throw new TypeError('Audio plan options must be an object');
  const brief = normalizeGameBrief(gameBrief), contract = normalizeEventContract(eventContract);
  const identity = await createGameRevisionIdentity(brief, contract);
  if (options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff)) throw new TypeError('seed must be an unsigned 32-bit integer');
  const director = options.director ?? directPrompt;
  if (typeof director !== 'function') throw new TypeError('director must be a trusted function');
  const directed = await director(brief.prompt, options.seed === undefined ? {} : { seed: options.seed });
  if (!record(directed) || !['cozy', 'neon', 'ruins'].includes(directed.style) || !['major', 'minor'].includes(directed.mode) || directed.bars !== 16 || directed.meter !== 4 || !Number.isFinite(directed.bpm) || directed.bpm < 60 || directed.bpm > 180 || !Number.isFinite(directed.rootMidi) || directed.rootMidi < 36 || directed.rootMidi > 84 || !Number.isInteger(directed.seed) || directed.seed < 0 || directed.seed > 0xffffffff) throw new TypeError('Director output is outside the validated local compiler capabilities');
  if (options.seed !== undefined && directed.seed !== options.seed) throw new TypeError('Director did not preserve the requested seed');
  const bindings = Object.fromEntries(contract.events.filter(event => event.cue !== null).map(event => [event.id, { cue: event.cue, required: event.required, maxRatePerSecond: event.maxRatePerSecond }]));
  // The shared contract exclusively controls bindings; local profile aliases are not used.
  const audioBrief = clone({ ...directed, prompt: brief.prompt, eventBindings: Object.fromEntries(Object.entries(bindings).map(([id, binding]) => [id, binding.cue])), sceneStates: contract.sceneStates });
  const score = composeScore(audioBrief);
  const audioSpec = {
    style: audioBrief.style, bpm: score.bpm, rootMidi: audioBrief.rootMidi, mode: audioBrief.mode,
    bars: score.bars, meter: score.meter, durationSeconds: score.duration, seed: audioBrief.seed,
    instruments: score.tracks.map(track => track.instrument), stems: ['core', 'texture', 'rhythm'],
    sampleRate: 44100, channels: 2, renderer: 'Tone.Offline', renderModes: ['synth', 'hybrid'],
    sceneStates: contract.sceneStates, scenePolicy: 'Explicit scene metadata and intensity; no inferred scene-to-music transitions.',
    spatialCapability: 'stereo-pan-only', cueIds: [...new Set(Object.values(bindings).map(binding => binding.cue))].sort(),
    ratePolicy: 'minimum interval of 1 / maxRatePerSecond per semantic event'
  };
  const planId = 'audio-plan-' + await hashCanonical({ ...identity, versions: PIPELINE_VERSIONS, audioSpec, bindings, musicScoreHash: await hashCanonical(score) });
  score.pipeline = { schemaVersion: 1, ...identity, planId, compilerVersion: PIPELINE_VERSIONS.compiler, soundBankVersion: PIPELINE_VERSIONS.soundBank };
  return deepFreeze({
    schemaVersion: 1, kind: 'game-audio-plan', ...identity, planId, seed: audioBrief.seed,
    compilerVersion: PIPELINE_VERSIONS.compiler, composerVersion: PIPELINE_VERSIONS.composer, soundBankVersion: PIPELINE_VERSIONS.soundBank,
    director: { kind: options.director ? 'injected-director' : 'local-rule-based-research-prototype', version: options.director ? null : PIPELINE_VERSIONS.director, modelConnected: options.director ? null : false, detail: audioBrief.director ?? null },
    gameBrief: brief, eventContract: contract, audioSpec, score, scoreHash: await hashCanonical(score), bindings,
    unmappedOptionalEvents: contract.events.filter(event => event.cue === null).map(event => event.id),
    mediaStatus: 'not-rendered'
  });
}

function validatePlan(plan) {
  if (!record(plan) || plan.schemaVersion !== 1 || plan.kind !== 'game-audio-plan') throw new TypeError('Unsupported audio plan schema');
  if (plan.compilerVersion !== PIPELINE_VERSIONS.compiler || plan.soundBankVersion !== PIPELINE_VERSIONS.soundBank) throw new TypeError('Unsupported audio compiler or sound bank version');
  if (typeof plan.planId !== 'string' || typeof plan.scoreHash !== 'string' || !record(plan.bindings) || !Array.isArray(plan.unmappedOptionalEvents)) throw new TypeError('Incomplete audio plan');
  const contract = normalizeEventContract(plan.eventContract);
  for (const event of contract.events) {
    const binding = Object.prototype.hasOwnProperty.call(plan.bindings, event.id) ? plan.bindings[event.id] : null;
    if (event.cue !== null && (!binding || binding.cue !== event.cue || binding.maxRatePerSecond !== event.maxRatePerSecond || binding.required !== event.required)) throw new TypeError('Plan bindings differ from event contract');
  }
  if (Object.keys(plan.bindings).some(id => !contract.events.some(event => event.id === id && event.cue !== null))) throw new TypeError('Plan contains an undeclared binding');
  if (!validateGameAudioJoin(plan, plan.score?.pipeline).accepted || plan.score?.pipeline?.planId !== plan.planId) throw new TypeError('Plan score identity differs');
  return true;
}

/** Source-only manifest: files/digests are filled only by a real media exporter. */
export function createAudioPackage(plan) {
  validatePlan(plan);
  return {
    schemaVersion: 1, kind: 'audio-package-source-manifest', plan: clone(plan),
    manifest: {
      schemaVersion: 1, packageId: plan.planId, identityKind: 'plan-content-hash; no media files have been packaged', ...Object.fromEntries(identityKeys.map(key => [key, plan[key]])),
      compilerVersion: plan.compilerVersion, composerVersion: plan.composerVersion, soundBankVersion: plan.soundBankVersion, seed: plan.seed,
      mediaStatus: 'not-rendered', files: [], qualityStatus: 'not-rendered-not-evaluated',
      music: { bpm: plan.audioSpec.bpm, meter: plan.audioSpec.meter, bars: plan.audioSpec.bars, durationSeconds: plan.score.duration, stems: plan.audioSpec.stems, sampleRate: 44100, channels: 2 },
      runtimeSources: [
        { module: 'src/audio-engine.mjs', version: PIPELINE_VERSIONS.runtime },
        { module: 'src/game-audio-pipeline.mjs', version: PIPELINE_VERSIONS.compiler },
        { module: 'src/director.mjs', version: PIPELINE_VERSIONS.director },
        { module: 'src/composer.mjs', version: PIPELINE_VERSIONS.composer },
        { module: 'vendor/Tone.js', version: PIPELINE_VERSIONS.tone }
      ],
      runtimeRequirements:{userGesture:'Explicit unlock before start; never autoplay.',soundBankEndpoint:'GET /api/sound-bank returns {manifest,files}; runtime is owned by the trusted host.',toneGlobal:'Load vendor/Tone.js before offline score rendering.'},
      soundBank: { manifest: 'assets/manifest.json', version: PIPELINE_VERSIONS.soundBank, schemaVersion: PIPELINE_VERSIONS.soundBankManifestSchema, contentHash: null, verification: 'Exporter must verify actual asset hashes and licenses.' }
    }
  };
}

/** No AudioContext is constructed here. The trusted game host owns one runtime. */
export function createGameAudioAdapter({ plan, runtime, clock = () => performance.now() / 1000, onError } = {}) {
  let snapshot, invalid, disposed = false, unlocked = false, status = 'locked', scene = null, intensity = .5, acceptedEvents = 0, operationToken = 0, lastError = null;
  const lastEvents = new Map();
  try {
    validatePlan(plan); snapshot = deepFreeze(clone(plan));
    for (const method of ['unlock', 'play', 'playEvent', 'setIntensity', 'pause', 'resume', 'stop', 'dispose']) if (typeof runtime?.[method] !== 'function') throw new TypeError('Runtime is missing ' + method);
    if (typeof clock !== 'function') throw new TypeError('clock must return monotonic seconds');
  } catch (error) { invalid = error.message; status = 'invalid'; }
  function fail(reason, detail = {}) {
    const result = { accepted: false, reason, ...detail }; lastError = result;
    if (typeof onError === 'function') try { onError(result); } catch {}
    return result;
  }
  const unavailable = () => disposed ? fail('disposed') : invalid ? fail('invalid-plan', { error: invalid }) : null;
  const failure = (operation, error) => fail('runtime-error', { operation, error: String(error?.message || error) });
  function runtimeState() { try { return runtime?.getState?.() ?? null; } catch { return null; } }
  function checkEnvelope(payload) {
    for (const key of identityKeys) if (payload[key] !== undefined && payload[key] !== snapshot[key]) return fail(key === 'revision' ? 'stale-revision' : 'event-version-mismatch', { field: key });
    return null;
  }
  return {
    async unlock() {
      const blocked = unavailable(); if (blocked) return blocked;
      try {
        const result = await runtime.unlock(); if (disposed) return fail('disposed');
        if ((typeof result === 'string' ? result : runtimeState()?.contextState) !== 'running') return fail('audio-not-running');
        unlocked = true; if (status === 'locked') status = 'ready'; return { accepted: true, state: 'running' };
      } catch (error) { return failure('unlock', error); }
    },
    async start(rendered) {
      const blocked = unavailable(); if (blocked) return blocked;
      if (!unlocked) return fail('locked', { action: 'Call unlock from an explicit user gesture before start.' });
      const joined = validateGameAudioJoin(snapshot, rendered?.score?.pipeline); if (!joined.accepted) return fail(joined.reason, { field: joined.field });
      if (rendered.score.pipeline.schemaVersion !== 1 || rendered.score.pipeline.planId !== snapshot.planId || rendered.score.pipeline.compilerVersion !== snapshot.compilerVersion || rendered.score.pipeline.soundBankVersion !== snapshot.soundBankVersion) return fail('audio-version-mismatch');
      const token = ++operationToken;
      try {
        if (await hashCanonical(rendered.score) !== snapshot.scoreHash) return fail('score-mismatch');
        if (disposed || token !== operationToken) return fail(disposed ? 'disposed' : 'cancelled');
        const result = await runtime.play(rendered, { loop: true });
        if (disposed || token !== operationToken || result === false) return fail(disposed ? 'disposed' : 'cancelled');
        status = 'playing'; return { accepted: true, planId: snapshot.planId };
      } catch (error) { return failure('start', error); }
    },
    async emit(id, payload = {}) {
      const blocked = unavailable(); if (blocked) return blocked;
      if (!unlocked) return fail('locked');
      if (status === 'paused') return fail('paused');
      if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(snapshot.bindings, id)) return fail(snapshot.unmappedOptionalEvents.includes(id) ? 'unmapped-optional-event' : 'unknown-event', { event: typeof id === 'string' ? id : null });
      if (!record(payload)) return fail('invalid-payload');
      const mismatch = checkEnvelope(payload); if (mismatch) return mismatch;
      for (const [key, min, max] of [['strength', 0, 1], ['pan', -1, 1]]) if (payload[key] !== undefined && (!Number.isFinite(payload[key]) || payload[key] < min || payload[key] > max)) return fail('invalid-payload', { field: key });
      if (payload.position !== undefined) return fail('unsupported-spatial-payload', { capability: 'stereo-pan-only' });
      const binding = snapshot.bindings[id]; let now;
      try { now = clock(); } catch (error) { return failure('clock', error); }
      if (!Number.isFinite(now)) return fail('invalid-clock');
      const previous = lastEvents.get(id), interval = binding.maxRatePerSecond === null ? 0 : 1 / binding.maxRatePerSecond;
      if (previous && now - previous.at < interval) return fail('rate-limited', { event: id, retryAfterSeconds: interval - (now - previous.at) });
      const reservation = { at: now }; lastEvents.set(id, reservation);
      const restore = () => { if (lastEvents.get(id) === reservation) { if (previous) lastEvents.set(id, previous); else lastEvents.delete(id); } };
      try {
        const result = await runtime.playEvent(binding.cue, { strength: payload.strength ?? 1, pan: payload.pan ?? 0 });
        if (disposed) { restore(); return fail('disposed'); }
        if (!result?.accepted) { restore(); return fail(result?.reason || 'event-rejected', { event: id }); }
        acceptedEvents++; return { ...result, accepted: true, event: id, cue: binding.cue };
      } catch (error) { restore(); return failure('emit', error); }
    },
    setScene(next) {
      const blocked = unavailable(); if (blocked) return blocked;
      if (!snapshot.eventContract.sceneStates.includes(next)) return fail('unknown-scene');
      scene = next; return { accepted: true, scene, musicTransition: 'explicit-intensity-only' };
    },
    setIntensity(value) {
      const blocked = unavailable(); if (blocked) return blocked;
      if (!Number.isFinite(value) || value < 0 || value > 1) return fail('invalid-intensity');
      try { const result = runtime.setIntensity(value); intensity = value; return { accepted: true, ...(record(result) ? result : {}), intensity }; } catch (error) { return failure('setIntensity', error); }
    },
    pause() {
      const blocked = unavailable(); if (blocked) return blocked;
      if (status !== 'playing') return fail('not-playing');
      try { operationToken++; runtime.pause(); status = 'paused'; return { accepted: true }; } catch (error) { return failure('pause', error); }
    },
    async resume() {
      const blocked = unavailable(); if (blocked) return blocked;
      if (!unlocked) return fail('locked'); if (status !== 'paused') return fail('not-paused');
      const token = ++operationToken;
      try { const result = await runtime.resume(); if (disposed || token !== operationToken || result === false) return fail(disposed ? 'disposed' : 'cancelled'); status = 'playing'; return { accepted: true }; } catch (error) { return failure('resume', error); }
    },
    stop() {
      const blocked = unavailable(); if (blocked) return blocked;
      try { operationToken++; runtime.stop(); status = unlocked ? 'ready' : 'locked'; return { accepted: true }; } catch (error) { return failure('stop', error); }
    },
    async dispose() {
      if (disposed) return { accepted: true, alreadyDisposed: true };
      disposed = true; unlocked = false; status = 'disposed'; operationToken++; lastEvents.clear();
      try { await runtime?.dispose?.(); return { accepted: true }; } catch (error) { return failure('dispose', error); }
    },
    getState() { return { status, disposed, unlocked, scene, intensity, acceptedEvents, lastError, identity: snapshot ? Object.fromEntries(identityKeys.map(key => [key, snapshot[key]])) : null, planId: snapshot?.planId ?? null, runtime: runtimeState() }; }
  };
}
