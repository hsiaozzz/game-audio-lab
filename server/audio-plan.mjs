import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createAudioPlan, canonicalJson } from '../src/game-audio-pipeline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVICE_VERSION = 'audio-service-v1';
export const FORMATS = Object.freeze([
  { id: 'opus-ogg', container: 'ogg', codec: 'opus', extension: '.ogg', mimeType: 'audio/ogg; codecs="opus"', sampleRate: 48000 },
  { id: 'aac-lc-m4a', container: 'mp4', codec: 'aac-lc', extension: '.m4a', mimeType: 'audio/mp4; codecs="mp4a.40.2"', sampleRate: 48000 }
]);
export const LIMITS = Object.freeze({ requestBytes: 262144, items: 32, events: 64, variants: 3, musicSlots: 4, durationSeconds: 65, maxTransferBytes: 64 * 1024 * 1024, maxDecodedPcmBytes: 256 * 1024 * 1024 });
export const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function apiError(status, code, message, retryable = false) {
  return Object.assign(new Error(message), { status, code, retryable });
}
const fail = (code, message) => { throw apiError(422, code, message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const idPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
function integer(value, fallback, min, max, name) {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < min || actual > max) fail('invalid-budget', `${name} must be an integer in ${min}..${max}`);
  return actual;
}
export function normalizeDelivery(input = {}) {
  if (!plain(input)) fail('invalid-delivery', 'delivery must be an object');
  const allowed = new Set(['profile','acceptedFormats','selection','formatOverrides','maxTransferBytes','maxDecodedPcmBytes','quality','sfxQuality','renderMode']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail('unsupported-delivery-field', `Unsupported delivery field: ${key}`);
  if (input.profile !== undefined && input.profile !== 'compact-opus-v1') fail('unsupported-profile', 'Only compact-opus-v1 is supported');
  if (input.selection !== undefined && input.selection !== 'one-format-per-item') fail('unsupported-selection', 'Only one-format-per-item is supported');
  const accepted = input.acceptedFormats ?? ['opus-ogg','aac-lc-m4a'];
  if (!Array.isArray(accepted) || !accepted.length || new Set(accepted).size !== accepted.length || accepted.some(id => !FORMATS.some(format => format.id === id))) fail('unsupported-format', 'acceptedFormats must contain unique supported format IDs');
  const overrides = input.formatOverrides ?? {};
  if (!plain(overrides) || Object.entries(overrides).some(([id,format]) => !idPattern.test(id) || !accepted.includes(format))) fail('invalid-format-override', 'formatOverrides must select accepted formats by item ID');
  const quality = input.quality ?? 'compact', sfxQuality = input.sfxQuality ?? 'standard', renderMode = input.renderMode ?? 'hybrid';
  if (!['compact','high'].includes(quality) || !['standard','compact-approved'].includes(sfxQuality) || !['hybrid','synth'].includes(renderMode)) fail('unsupported-quality', 'Unsupported music/SFX quality or rendering mode');
  return {
    profile: 'compact-opus-v1', acceptedFormats: [...accepted], selection: 'one-format-per-item',
    formatOverrides: Object.fromEntries(Object.entries(overrides).sort()), quality, sfxQuality, renderMode,
    maxTransferBytes: integer(input.maxTransferBytes, 12 * 1024 * 1024, 1024, LIMITS.maxTransferBytes, 'maxTransferBytes'),
    maxDecodedPcmBytes: integer(input.maxDecodedPcmBytes, 64 * 1024 * 1024, 4096, LIMITS.maxDecodedPcmBytes, 'maxDecodedPcmBytes')
  };
}

export async function createDeliveryPlan(input, { directorOptions } = {}) {
  if (!plain(input)) throw apiError(400, 'invalid-request', 'Expected a JSON object');
  for (const key of Object.keys(input)) if (!['gameBrief','eventContract','options','audioRequests','delivery'].includes(key)) fail('unsupported-request-field', `Unsupported plan field: ${key}`);
  if (!Array.isArray(input.eventContract?.events) || input.eventContract.events.length > LIMITS.events) fail('event-limit', `eventContract must have at most ${LIMITS.events} events`);
  if (input.options !== undefined && (!plain(input.options) || Object.keys(input.options).some(key => key !== 'seed'))) fail('unsupported-options', 'HTTP options only accepts seed');
  let sourcePlan;
  try { sourcePlan = await createAudioPlan(input.gameBrief, input.eventContract, { ...input.options, ...directorOptions }); }
  catch (error) { if (error.status) throw error; throw apiError(400, 'invalid-audio-contract', error.message); }
  const delivery = normalizeDelivery(input.delivery), contract = sourcePlan.eventContract;
  const requests = input.audioRequests ?? [
    ...contract.events.filter(event => event.cue !== null).map(event => ({ id: `sfx.${event.id}`, kind: 'sfx', eventId: event.id, required: event.required, variants: 1 })),
    ...(contract.sceneStates.length ? [{ id: 'bgm.exploration', kind: 'music', scene: contract.sceneStates.includes('exploration') ? 'exploration' : contract.sceneStates[0], required: true, loop: true, playback: 'mix' }] : [])
  ];
  if (!Array.isArray(requests) || !requests.length || requests.length > LIMITS.items) fail('item-limit', `audioRequests must have 1..${LIMITS.items} items`);
  const seen = new Set(), eventOwners = new Set(); let musicSlots = 0;
  const items = requests.map(request => {
    if (!plain(request) || !idPattern.test(request.id) || seen.has(request.id)) fail('invalid-item-id', 'Each audio request needs a unique safe ID');
    seen.add(request.id);
    if (request.required !== undefined && typeof request.required !== 'boolean') fail('invalid-item', 'required must be boolean');
    const formatId = delivery.formatOverrides[request.id] ?? delivery.acceptedFormats[0];
    const common = { id: request.id, kind: request.kind, required: request.required === true, formatId, sampleRate: 48000 };
    if (request.kind === 'sfx') {
      const allowed = new Set(['id','kind','eventId','required','variants','spatial']);
      if (Object.keys(request).some(key => !allowed.has(key))) fail('unsupported-sfx-field', 'SFX request contains an unsupported field');
      const event = contract.events.find(event => event.id === request.eventId);
      if (!event || !event.cue) fail('unmapped-event', `No cue is mapped for ${request.eventId}`);
      if (eventOwners.has(event.id)) fail('ambiguous-event', `Event ${event.id} has more than one SFX item`);
      eventOwners.add(event.id);
      let spatial={enabled:false};
      if(request.spatial!==undefined){
        const value=request.spatial;
        if(!plain(value)||typeof value.enabled!=='boolean'||Object.keys(value).some(key=>!['enabled','refDistance','maxDistance','rolloffFactor','distanceModel'].includes(key)))fail('invalid-spatial','spatial must contain enabled and supported distance parameters');
        const refDistance=value.refDistance??1,maxDistance=value.maxDistance??100,rolloffFactor=value.rolloffFactor??1,distanceModel=value.distanceModel??'inverse';
        if(!Number.isFinite(refDistance)||refDistance<=0||!Number.isFinite(maxDistance)||maxDistance<refDistance||maxDistance>10000||!Number.isFinite(rolloffFactor)||rolloffFactor<0||rolloffFactor>10||!['inverse','linear','exponential'].includes(distanceModel))fail('invalid-spatial','Invalid spatial distance configuration');
        spatial={enabled:value.enabled,refDistance,maxDistance,rolloffFactor,distanceModel};
      }
      const variants = integer(request.variants, 1, 1, ['victory','failure'].includes(event.cue) || delivery.renderMode === 'synth' && ['ui','collect','laser','charge'].includes(event.cue) ? 1 : LIMITS.variants, 'variants');
      return { ...common, required: common.required || event.required, eventId: event.id, cue: event.cue, maxRatePerSecond: event.maxRatePerSecond,
        variants, channels: 1, spatial,
        bitrateKbps: formatId === 'opus-ogg' ? delivery.sfxQuality === 'compact-approved' ? 32 : 48 : 64,
        estimatedDurationSeconds: ['explosion','victory','failure','charge'].includes(event.cue) ? 1.6 : .8 };
    }
    if (request.kind === 'music') {
      const allowed = new Set(['id','kind','scene','required','loop','playback','maxDurationSeconds']);
      if (Object.keys(request).some(key => !allowed.has(key))) fail('unsupported-music-field', 'Music request contains an unsupported field');
      if (++musicSlots > LIMITS.musicSlots) fail('music-limit', `At most ${LIMITS.musicSlots} music slots`);
      if (!contract.sceneStates.includes(request.scene)) fail('unknown-scene', 'Music scene must be declared in eventContract');
      if (request.loop !== undefined && typeof request.loop !== 'boolean') fail('invalid-loop', 'loop must be boolean');
      const playback = request.playback ?? 'mix';
      if (!['mix','stems'].includes(playback)) fail('unsupported-playback', 'Music playback is mix or stems');
      const duration = sourcePlan.score.duration;
      if (!Number.isFinite(duration) || duration > LIMITS.durationSeconds || (request.maxDurationSeconds !== undefined && (!Number.isFinite(request.maxDurationSeconds) || request.maxDurationSeconds <= 0 || duration > request.maxDurationSeconds))) fail('duration-budget', 'Composed music exceeds the requested maximum duration');
      return { ...common, scene: request.scene, loop: request.loop !== false, playback, variants: 1, channels: 2,
        bitrateKbps: formatId === 'opus-ogg' && delivery.quality !== 'high' ? 64 : 96, durationSeconds: duration,
        contentPolicy: 'shared-theme-per-plan' };
    }
    fail('unknown-item-kind', 'Audio request kind must be sfx or music');
  }).sort((a,b) => a.id.localeCompare(b.id, 'en'));
  for (const key of Object.keys(delivery.formatOverrides)) if (!seen.has(key)) fail('unknown-format-override', `Unknown item override: ${key}`);
  for (const event of contract.events) if (event.required && !eventOwners.has(event.id)) fail('required-event-missing', `Required event ${event.id} must have an audio request`);
  let transfer = 0, pcm = 0, requiredTransfer = 0, requiredPcm = 0;
  for (const item of items) {
    const copies = item.kind === 'music' ? item.playback === 'stems' ? 3 : 1 : item.variants;
    const duration = item.durationSeconds ?? item.estimatedDurationSeconds;
    const itemTransfer = Math.ceil(duration * item.bitrateKbps * 1000 / 8 * copies * 1.6 + 4096 * copies);
    const itemPcm = Math.ceil(duration * 48000) * item.channels * 4 * copies;
    transfer += itemTransfer; pcm += itemPcm;
    if (item.required) { requiredTransfer += itemTransfer; requiredPcm += itemPcm; }
  }
  // Planning is conservative; the worker also checks actual encoded and decoded bytes.
  if (requiredPcm > delivery.maxDecodedPcmBytes || requiredTransfer > delivery.maxTransferBytes) fail('estimated-budget-exceeded', 'Required audio exceeds the estimated transfer or decoded-memory budget');
  const identity = Object.fromEntries(['projectId','revision','briefHash','contractVersion','contractHash'].map(key => [key,sourcePlan[key]]));
  const sourceHashes = {};
  for (const file of ['src/audio-engine.mjs','src/composer.mjs','src/director.mjs','src/service-render-worker.mjs','server/audio-renderer.mjs','server/audio-media.mjs','assets/manifest.json','vendor/Tone.js']) sourceHashes[file] = createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex');
  const core = { schemaVersion: 1, kind: 'audio-delivery-plan', identity, sourcePlan, items, delivery,
    estimates: { maxTransferBytes: transfer, decodedPcmBytes: pcm, requiredTransferBytes: requiredTransfer, requiredDecodedPcmBytes: requiredPcm, accuracy: 'conservative-estimate-not-measurement' },
    versions: { service: SERVICE_VERSION, sourceHashes, algorithm: directorOptions?.algorithmIdentity ?? {kind:'local-rule-based',version:'seeded-v1'} } };
  const planDigest = digest(core);
  return { ...core, planDigest, planId: 'plan-' + planDigest, status: 'awaiting-confirmation' };
}

export function verifyDeliveryPlan(plan) {
  if (!plan || plan.kind !== 'audio-delivery-plan' || plan.schemaVersion !== 1) throw apiError(400, 'invalid-plan', 'Unsupported stored plan');
  const { planId, planDigest, status, ...core } = plan;
  if (digest(core) !== planDigest || planId !== 'plan-' + planDigest) throw apiError(409, 'plan-digest-mismatch', 'Stored audio plan content differs from its identity');
  return true;
}
