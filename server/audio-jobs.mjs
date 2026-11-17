import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { canonicalJson } from '../src/game-audio-pipeline.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest('hex');
const copy = value => JSON.parse(canonicalJson(value));
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const terminal = new Set(['ready', 'partial-ready', 'failed', 'cancelled']);
const digestPattern = /^[a-f0-9]{64}$/;
const identityFields = ['projectId', 'revision', 'briefHash', 'contractVersion', 'contractHash'];

export function audioJobError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, retryable: false, ...extra });
}
const bad = (code, message) => audioJobError(400, code, message);
const missing = () => audioJobError(404, 'not_found', 'The requested audio resource was not found');
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
async function acquireStoreLock(root) {
  const filename = path.join(root, '.audio-jobs.lock');
  const lease = { schemaVersion: 1, pid: process.pid, host: hostname(), nonce: randomUUID(), createdAt: new Date().toISOString() };
  const contents = canonicalJson(lease) + '\n';
  await fs.mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try { const handle = await fs.open(filename, 'wx'); try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); } break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing, previous;
      try { previous = await fs.readFile(filename, 'utf8'); existing = JSON.parse(previous); } catch { throw audioJobError(503, 'store_in_use', 'The audio data directory has an invalid or changing ownership lock', { retryable: true }); }
      let alive = true;
      if (existing.host === hostname() && Number.isSafeInteger(existing.pid) && existing.pid > 0) { try { process.kill(existing.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; } }
      if (alive) throw audioJobError(503, 'store_in_use', 'Another service process owns this audio data directory', { retryable: true });
      if (await fs.readFile(filename, 'utf8') !== previous) continue;
      try { await fs.unlink(filename); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      if (attempt === 2) throw audioJobError(503, 'store_in_use', 'Audio data directory ownership changed during recovery', { retryable: true });
    }
  }
  async function assertOwned() {
    let current; try { current = await fs.readFile(filename, 'utf8'); } catch { current = null; }
    if (current !== contents) throw audioJobError(503, 'store_lock_lost', 'The audio data directory is no longer owned by this service', { retryable: true });
  }
  await assertOwned();
  return { assertOwned, async release() { try { if (await fs.readFile(filename, 'utf8') === contents) await fs.unlink(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; } } };
}
function ownerValue(options) {
  const owner = options?.owner;
  if (typeof owner !== 'string' || !owner.trim() || owner.length > 512) throw audioJobError(401, 'owner_required', 'An authenticated owner is required');
  return owner;
}
function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) throw bad('invalid_media_path', 'Renderer returned an invalid relative media path');
  return value;
}
function itemFolder(id) { return `media/${id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60)}-${hash(id).slice(0, 12)}`; }
function validateIdentity(value) {
  if (!plain(value) || typeof value.projectId !== 'string' || !value.projectId || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.contractVersion) || value.contractVersion < 1 || !digestPattern.test(value.briefHash) || !digestPattern.test(value.contractHash)) throw bad('invalid_identity', 'A complete shared game identity is required');
}
function validatePlan(plan) {
  if (!plain(plan) || plan.schemaVersion !== 1 || plan.kind !== 'audio-delivery-plan' || !digestPattern.test(plan.planDigest) || plan.planId !== 'plan-' + plan.planDigest) throw bad('invalid_plan', 'Unsupported delivery plan');
  validateIdentity(plan.identity);
  const { planId, planDigest, status, ...core } = plan;
  if (hash(core) !== planDigest) throw audioJobError(409, 'plan_digest_mismatch', 'Plan contents do not match the confirmed digest');
  if (!plain(plan.sourcePlan) || !Array.isArray(plan.items) || !plan.items.length || plan.items.length > 128) throw bad('invalid_plan', 'A delivery plan must contain a source plan and media items');
  for (const key of identityFields) if (plan.sourcePlan[key] !== plan.identity[key]) throw bad('invalid_plan_identity', 'Source plan and delivery plan identities differ');
  const ids = new Set();
  for (const item of plan.items) {
    if (!plain(item) || typeof item.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(item.id) || ids.has(item.id) || !['sfx', 'music'].includes(item.kind) || typeof item.required !== 'boolean' || !Number.isSafeInteger(item.variants) || item.variants < 1 || item.variants > 16 || (item.kind === 'music' && !['mix', 'stems'].includes(item.playback)) || item.sampleRate !== 48000 || ![1, 2].includes(item.channels) || typeof item.formatId !== 'string') throw bad('invalid_plan_item', 'A delivery plan contains an invalid or duplicate media item');
    ids.add(item.id);
  }
  if (!plain(plan.delivery) || plan.delivery.selection !== 'one-format-per-item') throw bad('invalid_delivery', 'One delivery format per item is required');
  for (const key of ['maxTransferBytes', 'maxDecodedPcmBytes']) if (!Number.isSafeInteger(plan.delivery[key]) || plan.delivery[key] < 1) throw bad('invalid_budget', 'Delivery budgets must be positive safe integers');
  return plan;
}

/**
 * Persistent, owner-isolated local job coordinator. Rendering is injected for tests;
 * the default renderer is loaded only when a media item actually needs rendering.
 */
export async function createAudioJobStore({ dataDir, renderItem, cacheKeyForItem, concurrency = 1, maxQueuedPerOwner = 16, maxQueued = 64 } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('Audio job dataDir is required');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new TypeError('Audio job concurrency must be between 1 and 8');
  for (const limit of [maxQueuedPerOwner, maxQueued]) if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new TypeError('Audio queue limits must be positive safe integers no greater than 10000');
  const root = path.resolve(dataDir), temporaryRoot = path.join(root, 'temporary');
  const lease = await acquireStoreLock(root);
  await fs.mkdir(temporaryRoot, { recursive: true });
  const plans = new Map(), jobs = new Map(), idempotency = new Map();
  const queue = [], queued = new Set(), active = new Map();
  let closing = false, closed = false, mutationTail = Promise.resolve(), drainPromise, mediaModule;
  const namespace = owner => path.join(root, 'owners', hash(owner));
  const planKey = (owner, id) => `${hash(owner)}:${id}`;
  const jobPath = job => path.join(namespace(job.owner), 'jobs', `${job.id}.json`);
  const planPath = (owner, id) => path.join(namespace(owner), 'plans', `${id}.json`);
  const cacheRoot = (owner, projectId) => path.join(namespace(owner), 'cache', hash(projectId));
  const packagePath = (owner, digest) => path.join(namespace(owner), 'packages', digest);
  const transaction = operation => {
    const result = mutationTail.then(operation);
    mutationTail = result.catch(() => {});
    return result;
  };
  async function writeJson(filename, value) {
    await lease.assertOwned();
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(canonicalJson(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, filename);
  }
  async function readJson(filename) { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  async function safeRemoveTemporary(directory) {
    const absolute = path.resolve(directory);
    if (!absolute.startsWith(temporaryRoot + path.sep) || absolute === temporaryRoot) throw new Error('Temporary audio path escaped its owned directory');
    await fs.rm(absolute, { recursive: true, force: true });
  }
  const persist = job => writeJson(jobPath(job), job);
  function ensureOpen() { if (closing || closed) throw audioJobError(503, 'store_closed', 'Audio job service is shutting down', { retryable: true }); }
  function ownedJob(id, owner) {
    const job = jobs.get(id);
    if (!job || job.owner !== owner) throw missing();
    return job;
  }
  function ownedPlan(id, owner) {
    const plan = plans.get(planKey(owner, id));
    if (!plan) throw missing();
    return plan;
  }
  function completion(job) {
    const ready = job.components.filter(item => item.status === 'ready');
    return { requiredReady: job.components.filter(item => item.required).every(item => item.status === 'ready'), allSelectedReady: ready.length === job.components.length, ready: ready.length, total: job.components.length, failed: job.components.filter(item => item.status === 'failed').length };
  }
  function publicJob(job) {
    const progress = completion(job);
    const manifestUrl = job.packageId ? `/v1/audio/packages/${job.packageId}/manifest` : null;
    // Rendering can finish before package publication. Playback readiness must
    // describe the immutable package actually referenced by this job snapshot.
    const published = new Set(job.packageId ? job.publishedItemIds || [] : []);
    const requiredReady = !!job.packageId && job.components.filter(item => item.required).every(item => published.has(item.id));
    const allSelectedReady = !!job.packageId && job.request.acceptedItems.every(id => published.has(id));
    return {
      id: job.id, jobId: job.id, status: job.status, statusUrl: `/v1/audio/jobs/${job.id}`,
      planId: job.request.planId, planDigest: job.request.planDigest, identity: copy(job.request.identity),
      selectionDigest: job.selectionDigest, acceptedItems: [...job.request.acceptedItems], delivery: copy(job.request.delivery),
      components: job.components.map(item => ({ id: item.id, kind: item.kind, required: item.required, status: item.status, attempts: item.attempts, cacheHit: item.cacheHit, ...(item.error ? { error: copy(item.error) } : {}), ...(item.status === 'ready' ? { fileCount: item.result.files.length } : {}) })),
      requiredReady, allSelectedReady,
      progress: { ready: progress.ready, total: progress.total, failed: progress.failed },
      packageId: job.packageId, manifestUrl, packageUrl: manifestUrl,
      filesBaseUrl: job.packageId ? `/v1/audio/packages/${job.packageId}/files/` : null,
      createdAt: job.createdAt, updatedAt: job.updatedAt, ...(job.completedAt ? { completedAt: job.completedAt } : {}),
      ...(job.retryOf ? { retryOf: job.retryOf, retryItems: [...job.retryItems] } : {}),
      ...(job.recoveredAt ? { recoveredAt: job.recoveredAt } : {}), ...(job.budget ? { budget: copy(job.budget) } : {})
    };
  }
  function publicFailure(error, componentId) {
    return { code: /^[a-z][a-z0-9_-]{0,79}$/.test(error?.code || '') ? error.code : 'render_failed', message: error?.publicMessage || (error?.code === 'transfer_budget_exceeded' ? 'Measured files exceed the confirmed transfer budget' : error?.code === 'decoded_budget_exceeded' ? 'Measured decoded audio exceeds the confirmed PCM budget' : 'Audio component could not be delivered'), retryable: error?.retryable !== false, componentId };
  }
  function normalizeRequest(input, owner) {
    if (!plain(input)) throw bad('invalid_request', 'A confirmed delivery request is required');
    const plan = ownedPlan(input.planId, owner);
    if (input.planDigest !== plan.planDigest) throw audioJobError(409, 'plan_digest_mismatch', 'The confirmed plan digest does not match');
    if (!plain(input.identity) || !same(input.identity, plan.identity)) throw audioJobError(409, 'identity_mismatch', 'The game identity differs from the confirmed plan');
    if (!plain(input.delivery) || !same(input.delivery, plan.delivery)) throw audioJobError(409, 'delivery_mismatch', 'Delivery settings changed; create a new plan');
    if (!Array.isArray(input.acceptedItems) || !input.acceptedItems.length || input.acceptedItems.some(id => typeof id !== 'string')) throw bad('invalid_selection', 'Select at least one declared media item');
    const acceptedItems = [...new Set(input.acceptedItems)].sort();
    for (const id of acceptedItems) if (!plan.items.some(item => item.id === id)) throw bad('unknown_item', 'A selected item is not in the confirmed plan');
    if (plan.items.some(item => item.required && !acceptedItems.includes(item.id))) throw bad('required_item_missing', 'All required media items must be selected');
    return { plan, request: { planId: plan.planId, planDigest: plan.planDigest, identity: copy(plan.identity), acceptedItems, delivery: copy(plan.delivery) } };
  }
  function idempotencyFor(owner, projectId, key, body) {
    if (typeof key !== 'string' || !key.trim() || key.length > 256) throw bad('idempotency_key_required', 'A nonempty Idempotency-Key of at most 256 characters is required');
    return { scope: `${hash(owner)}:${hash(projectId)}:${hash(key)}`, requestDigest: hash(body) };
  }
  async function renderer() { if (!mediaModule) mediaModule = await import('./audio-media.mjs'); return mediaModule; }
  async function inputCacheKey(plan, item, signal) {
    const key = cacheKeyForItem ? await cacheKeyForItem({ plan, item, signal }) : !renderItem ? await (await renderer()).mediaItemCacheKey({ plan, item, signal }) : hash({ schemaVersion: 1, fakeRenderer: true, sourcePlan: plan.sourcePlan, item });
    if (typeof key !== 'string' || !key) throw bad('invalid_cache_key', 'Renderer returned an invalid cache key');
    return hash(key);
  }
  async function checkedResult(result, directory, item) {
    if (!plain(result) || !Array.isArray(result.files) || !result.files.length || result.files.length > 64 || result.quality?.technical !== 'passed') throw audioJobError(422, 'invalid_render_result', 'Renderer did not return technically validated audio', { retryable: false });
    const checked = copy(result), realDirectory = await fs.realpath(directory), ids = new Set(), names = new Set();
    for (const file of checked.files) {
      relativeFile(file.path);
      if (typeof file.id !== 'string' || !file.id || ids.has(file.id) || names.has(file.path.toLowerCase())) throw bad('duplicate_media_file', 'Renderer returned duplicate media identities');
      ids.add(file.id); names.add(file.path.toLowerCase());
      const filename = path.join(directory, ...file.path.split('/')), real = await fs.realpath(filename), stat = await fs.lstat(filename);
      if (!real.startsWith(realDirectory + path.sep) || !stat.isFile() || stat.isSymbolicLink()) throw bad('invalid_media_path', 'Media files must stay within the owned render directory');
      const bytes = await fs.readFile(filename);
      if (file.bytes !== bytes.length || !bytes.length || file.sha256 !== hash(bytes)) throw audioJobError(422, 'media_integrity_mismatch', 'Rendered media size or digest is invalid', { retryable: true });
      const decodedFrames = file.decodedFrames ?? file.trim?.decodedFrames ?? file.frames;
      if (!Number.isSafeInteger(file.frames) || file.frames < 1 || !Number.isSafeInteger(decodedFrames) || decodedFrames < file.frames || !Number.isSafeInteger(file.decodedPcmBytes) || file.decodedPcmBytes !== decodedFrames * file.channels * 4 || file.sampleRate !== item.sampleRate || file.channels !== item.channels || file.formatId !== item.formatId || !/^audio\//.test(file.mimeType || '') || typeof file.codec !== 'string' || !plain(file.encoding)) throw audioJobError(422, 'invalid_audio_metadata', 'Measured audio metadata does not match the confirmed item', { retryable: false });
      const expected = { 'opus-ogg': { container: 'ogg', codec: 'opus', mime: 'audio/ogg' }, 'aac-lc-m4a': { container: 'mp4', codec: 'aac-lc', mime: 'audio/mp4' } }[item.formatId];
      if (!expected || file.container !== expected.container || file.codec !== expected.codec || !file.mimeType.startsWith(expected.mime) || file.encoding.targetBitrateKbps !== item.bitrateKbps) throw audioJobError(422, 'invalid_audio_format', 'Encoded format differs from the confirmed delivery format', { retryable: false });
    }
    if (item.kind === 'sfx') {
      if (!plain(checked.sfx) || checked.sfx.eventId !== item.eventId || !Array.isArray(checked.sfx.variants) || checked.sfx.variants.length !== item.variants || checked.files.length !== item.variants || new Set(checked.sfx.variants).size !== item.variants || checked.sfx.variants.some(id => !ids.has(id))) throw bad('invalid_sfx_mapping', 'Rendered SFX variants do not match the confirmed event');
    } else {
      const music = checked.music;
      if (!plain(music) || music.scene !== item.scene || !plain(music.loop) || music.loop.referenceSampleRate !== item.sampleRate || !Number.isSafeInteger(music.loop.startFrame) || !Number.isSafeInteger(music.loop.endFrame) || music.loop.startFrame < 0 || music.loop.endFrame <= music.loop.startFrame || checked.files.some(file => music.loop.endFrame > file.frames) || (item.playback === 'mix' ? checked.files.length !== 1 || !ids.has(music.mixFileId) || music.stemFileIds?.length : !Array.isArray(music.stemFileIds) || music.stemFileIds.length !== 3 || checked.files.length !== 3 || new Set(music.stemFileIds).size !== 3 || music.stemFileIds.some(id => !ids.has(id)) || !!music.mixFileId)) throw bad('invalid_music_mapping', 'Rendered music does not match the confirmed playback layout');
    }
    return checked;
  }
  async function readCache(plan, item, owner, key) {
    const parent = cacheRoot(owner, plan.identity.projectId);
    let directory = path.join(parent, key);
    try {
      let pointer; try { pointer = await readJson(path.join(parent, `${key}.pointer.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (pointer) { if (typeof pointer.directory !== 'string' || !new RegExp(`^${key}-[a-f0-9-]{36}$`).test(pointer.directory)) return null; directory = path.join(parent, pointer.directory); }
      const record = await readJson(path.join(directory, 'result.json'));
      if (record.inputKey !== key) return null;
      return { result: await checkedResult(record.result, directory, item), directory };
    } catch { return null; }
  }
  async function renderCached(plan, item, owner, signal) {
    const key = await inputCacheKey(plan, item, signal), cached = await readCache(plan, item, owner, key);
    if (cached) return { ...cached, cacheHit: true, inputKey: key };
    signal.throwIfAborted();
    const taskDirectory = await fs.mkdtemp(path.join(temporaryRoot, 'item-')), work = path.join(taskDirectory, 'work'), prepared = path.join(taskDirectory, 'cache');
    await fs.mkdir(work); await fs.mkdir(prepared);
    try {
      const result = await checkedResult(await (renderItem || (await renderer()).renderMediaItem)({ plan: copy(plan), item: copy(item), directory: work, signal }), work, item);
      signal.throwIfAborted();
      for (const file of result.files) { const destination = path.join(prepared, ...file.path.split('/')); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(path.join(work, ...file.path.split('/')), destination); }
      signal.throwIfAborted();
      await writeJson(path.join(prepared, 'result.json'), { schemaVersion: 1, inputKey: key, result });
      const parent = cacheRoot(owner, plan.identity.projectId); await fs.mkdir(parent, { recursive: true });
      let directory = path.join(parent, key);
      try { await fs.rename(prepared, directory); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        const existing = await readCache(plan, item, owner, key);
        if (existing) return { ...existing, cacheHit: true, inputKey: key };
        // A damaged previous cache is retained for diagnosis; never overwrite files
        // that an already published package might still be copying.
        directory = path.join(parent, `${key}-${randomUUID()}`); await fs.rename(prepared, directory);
        await writeJson(path.join(parent, `${key}.pointer.json`), { schemaVersion: 1, directory: path.basename(directory) });
      }
      return { result, directory, cacheHit: false, inputKey: key };
    } finally { await safeRemoveTemporary(taskDirectory); }
  }
  let licensePromise;
  async function licenses() {
    if (!licensePromise) licensePromise = (async () => {
      const sources = ['THIRD_PARTY_NOTICES.md', 'vendor/Tone.LICENSE.md', 'vendor/Tone.js.LICENSE.txt', 'assets/licenses/Kenney-CC0.md', 'assets/licenses/VSCO-CC0.txt'];
      try { if ((await fs.stat(path.join(projectRoot, 'LICENSE'))).isFile()) sources.unshift('LICENSE'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const texts = await Promise.all(sources.map(async file => `${file}\n${await fs.readFile(path.join(projectRoot, file), 'utf8')}`));
      return Buffer.from(texts.join('\n\n--------------------\n\n') + '\n');
    })().catch(error => { licensePromise = undefined; throw error; });
    return licensePromise;
  }
  async function packageInputs(job, components) {
    const files = [], copies = [], sfx = {}, music = {}, itemProvenance = {}, qualities = {}, seen = new Set();
    for (const component of components.filter(value => value.status === 'ready')) {
      const { result } = component, remap = new Map();
      for (const [index, original] of result.files.entries()) {
        const id = `${component.id}.file-${index + 1}`, relative = `${itemFolder(component.id)}/${relativeFile(original.path)}`;
        if (seen.has(relative.toLowerCase())) throw new Error('Duplicate packaged path'); seen.add(relative.toLowerCase());
        remap.set(original.id, id); files.push({ ...copy(original), id, itemId: component.id, kind: component.kind, path: relative });
        copies.push({ from: path.join(component.directory, ...original.path.split('/')), to: relative, sha256: original.sha256, bytes: original.bytes });
      }
      if (result.sfx) sfx[component.id] = { ...copy(result.sfx), variants: result.sfx.variants.map(id => remap.get(id)) };
      if (result.music) {
        const entry = copy(result.music);
        if (entry.mixFileId) entry.mixFileId = remap.get(entry.mixFileId);
        if (entry.stemFileIds) entry.stemFileIds = entry.stemFileIds.map(id => remap.get(id));
        if (entry.stemGainDb) entry.stemGainDb = Object.fromEntries(Object.entries(entry.stemGainDb).map(([id, gain]) => [remap.get(id) || id, gain]));
        if (entry.stemRoles) entry.stemRoles = Object.fromEntries(Object.entries(entry.stemRoles).map(([id, role]) => [remap.get(id) || id, role]));
        music[component.id] = entry;
      }
      itemProvenance[component.id] = copy(result.provenance || {}); qualities[component.id] = copy(result.quality);
    }
    const buffers = [
      { id: 'provenance.licenses', path: 'provenance/LICENSES.txt', mimeType: 'text/plain; charset=utf-8', bytes: await licenses() },
      { id: 'provenance.assets', path: 'provenance/assets.json', mimeType: 'application/json', bytes: Buffer.from(canonicalJson({ schemaVersion: 1, planId: job.request.planId, items: itemProvenance }) + '\n') }
    ];
    for (const support of buffers) files.push({ id: support.id, kind: 'provenance', path: support.path, sha256: hash(support.bytes), bytes: support.bytes.length, mimeType: support.mimeType, decodedPcmBytes: 0 });
    const transferBytes = files.reduce((sum, file) => sum + file.bytes, 0), decodedPcmBytes = files.reduce((sum, file) => sum + file.decodedPcmBytes, 0);
    if (transferBytes > job.request.delivery.maxTransferBytes) throw audioJobError(422, 'transfer_budget_exceeded', 'Measured files exceed the confirmed transfer budget', { retryable: false });
    if (decodedPcmBytes > job.request.delivery.maxDecodedPcmBytes) throw audioJobError(422, 'decoded_budget_exceeded', 'Measured decoded audio exceeds the confirmed PCM budget', { retryable: false });
    return { files, copies, buffers, sfx, music, qualities, budget: { transferBytes, decodedPcmBytes, maxTransferBytes: job.request.delivery.maxTransferBytes, maxDecodedPcmBytes: job.request.delivery.maxDecodedPcmBytes, measurement: 'Actual encoded and provenance file bytes; actual decoded Float32 frames. Manifest transport overhead is excluded.' } };
  }
  async function publishPackage(job) {
    const snapshot = copy(job), ready = snapshot.components.filter(item => item.status === 'ready');
    if (!ready.length) return;
    const inputs = await packageInputs(snapshot, ready), availability = completion(snapshot);
    const manifestCore = {
      schemaVersion: 1, kind: 'audio-media-package', identity: snapshot.request.identity,
      planId: snapshot.request.planId, planDigest: snapshot.request.planDigest, selectionDigest: snapshot.selectionDigest,
      acceptedItems: snapshot.request.acceptedItems, deliveredItems: ready.map(item => item.id).sort(),
      requiredReady: availability.requiredReady, allSelectedReady: availability.allSelectedReady,
      delivery: snapshot.request.delivery, files: inputs.files, sfx: inputs.sfx, music: inputs.music,
      provenance: { licensesPath: 'provenance/LICENSES.txt', assetsPath: 'provenance/assets.json' },
      quality: { technical: 'passed', binding: 'contract-validated-gameplay-not-evaluated', listening: 'not-evaluated', components: inputs.qualities },
      budget: inputs.budget
    };
    const packageId = hash(manifestCore), manifest = { ...manifestCore, packageId }, destination = packagePath(job.owner, packageId);
    let exists = false;
    try { exists = same(await readJson(path.join(destination, 'manifest.json')), manifest); } catch {}
    if (!exists) {
      const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'package-'));
      try {
        for (const file of inputs.copies) {
          const bytes = await fs.readFile(file.from);
          if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw audioJobError(422, 'media_integrity_mismatch', 'Cached media changed during package assembly', { retryable: true });
          const target = path.join(temporary, ...file.to.split('/')); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
        }
        for (const file of inputs.buffers) { const target = path.join(temporary, ...file.path.split('/')); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.bytes); }
        await writeJson(path.join(temporary, 'manifest.json'), manifest);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        try { await fs.rename(temporary, destination); }
        catch (error) { if (!same(await readJson(path.join(destination, 'manifest.json')), manifest)) throw error; }
      } finally { await safeRemoveTemporary(temporary); }
    }
    await transaction(async () => {
      if (closed) return;
      const publication = { packageId, publishedItemIds: [...manifest.deliveredItems], budget: inputs.budget, updatedAt: new Date().toISOString() };
      // Persist the pointer and coverage together, then expose them together.
      // GET continues to see the preceding complete publication until this succeeds.
      await persist({ ...job, ...publication });
      Object.assign(job, publication);
    });
  }
  function schedule(job) {
    if (closing || terminal.has(job.status) || queued.has(job.id) || active.has(job.id)) return;
    queued.add(job.id); queue.push(job.id); queueMicrotask(pump);
  }
  function pump() {
    if (closing) return;
    while (active.size < concurrency && queue.length) {
      const id = queue.shift(); queued.delete(id); const job = jobs.get(id);
      if (!job || terminal.has(job.status)) continue;
      const controller = new AbortController();
      const promise = processJob(job, controller.signal).catch(async error => {
        await transaction(async () => {
          if (closed || job.status === 'cancelled') return;
          for (const item of job.components) if (['queued', 'rendering'].includes(item.status)) { item.status = closing ? 'queued' : 'failed'; item.error = closing ? null : publicFailure(error, item.id); }
          job.status = closing ? 'queued' : job.components.some(item => item.status === 'ready') ? 'partial-ready' : 'failed';
          job.updatedAt = new Date().toISOString(); if (!closing) job.completedAt = job.updatedAt; await persist(job);
        });
      }).finally(() => { active.delete(id); pump(); });
      active.set(id, { controller, promise });
    }
  }
  async function processJob(job, signal) {
    const plan = ownedPlan(job.request.planId, job.owner);
    await transaction(async () => { if (job.status === 'cancelled' || closing) return; job.status = 'rendering'; job.updatedAt = new Date().toISOString(); await persist(job); });
    if (job.status === 'cancelled' || closing) return;
    if (job.components.some(item => item.status === 'ready')) await publishPackage(job);
    const order = [...job.components].sort((a, b) => Number(b.kind === 'sfx') - Number(a.kind === 'sfx') || Number(b.required) - Number(a.required) || a.id.localeCompare(b.id));
    for (const component of order) {
      if (closing || job.status === 'cancelled') break;
      if (component.status !== 'queued') continue;
      await transaction(async () => { if (job.status === 'cancelled' || closing) return; component.status = 'rendering'; component.attempts++; component.error = null; job.updatedAt = new Date().toISOString(); await persist(job); });
      if (job.status === 'cancelled' || closing) break;
      try {
        const item = plan.items.find(value => value.id === component.id), rendered = await renderCached(plan, item, job.owner, signal);
        if (closing || job.status === 'cancelled') break;
        const candidate = { ...component, status: 'ready', ...rendered };
        await packageInputs(job, [...job.components.filter(value => value.status === 'ready'), candidate]);
        await transaction(async () => { if (closing || job.status === 'cancelled') return; Object.assign(component, candidate); job.updatedAt = new Date().toISOString(); await persist(job); });
        if (component.status === 'ready') await publishPackage(job);
      } catch (error) {
        await transaction(async () => {
          if (closed || job.status === 'cancelled') return;
          component.status = closing ? 'queued' : 'failed'; component.error = closing ? null : publicFailure(error, component.id); delete component.result; delete component.directory;
          job.updatedAt = new Date().toISOString(); await persist(job);
        });
      }
    }
    await transaction(async () => {
      if (closed || job.status === 'cancelled') return;
      const counts = completion(job);
      job.status = closing ? 'queued' : counts.allSelectedReady ? 'ready' : counts.ready ? 'partial-ready' : 'failed';
      job.updatedAt = new Date().toISOString(); if (!closing) job.completedAt = job.updatedAt; await persist(job);
    });
  }
  async function restore() {
    let owners; try { owners = await fs.readdir(path.join(root, 'owners'), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const ownerDirectory of owners.filter(entry => entry.isDirectory() && digestPattern.test(entry.name))) {
      const base = path.join(root, 'owners', ownerDirectory.name);
      for (const [folder, load] of [
        ['plans', async entry => { const record = await readJson(entry); if (hash(record.owner) !== ownerDirectory.name) throw new Error('Stored plan owner is invalid'); validatePlan(record.plan); plans.set(planKey(record.owner, record.plan.planId), record.plan); }],
        ['jobs', async entry => {
          const job = await readJson(entry);
          if (hash(job.owner) !== ownerDirectory.name || typeof job.id !== 'string' || !Array.isArray(job.components)) throw new Error('Stored audio job is invalid');
          let publishedItemIds = [];
          if (job.packageId) {
            if (!digestPattern.test(job.packageId)) throw audioJobError(500, 'package_integrity_error', 'Stored package identity is invalid');
            const manifest = await readJson(path.join(packagePath(job.owner, job.packageId), 'manifest.json'));
            const { packageId, ...core } = manifest;
            if (packageId !== job.packageId || hash(core) !== packageId || manifest.planId !== job.request.planId || manifest.selectionDigest !== job.selectionDigest || !Array.isArray(manifest.deliveredItems) || manifest.deliveredItems.some(id => !job.request.acceptedItems.includes(id))) throw audioJobError(500, 'package_integrity_error', 'Stored package publication is invalid');
            publishedItemIds = [...manifest.deliveredItems];
          }
          // Older persisted jobs predate this coverage field. The immutable
          // manifest is authoritative even when a stale field is already present.
          if (!same(job.publishedItemIds ?? null, publishedItemIds)) { job.publishedItemIds = publishedItemIds; await persist(job); }
          jobs.set(job.id, job); if (job.idempotency) idempotency.set(job.idempotency.scope, { id: job.id, requestDigest: job.idempotency.requestDigest });
          if (!terminal.has(job.status)) {
            const plan = ownedPlan(job.request.planId, job.owner);
            for (const component of job.components) {
              if (component.status === 'rendering') component.status = 'queued';
              if (component.status === 'ready') {
                try {
                  if (!path.resolve(component.directory).startsWith(cacheRoot(job.owner, plan.identity.projectId) + path.sep)) throw new Error('Invalid restored cache directory');
                  component.result = await checkedResult(component.result, component.directory, plan.items.find(item => item.id === component.id));
                } catch { component.status = 'queued'; component.error = null; delete component.result; delete component.directory; }
              }
            }
            job.status = 'queued'; job.recoveredAt = new Date().toISOString(); job.updatedAt = job.recoveredAt; await persist(job);
          }
        }]
      ]) {
        let files; try { files = await fs.readdir(path.join(base, folder)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const file of files.filter(name => name.endsWith('.json')).sort()) await load(path.join(base, folder, file));
      }
    }
    for (const job of jobs.values()) if (!terminal.has(job.status)) { ownedPlan(job.request.planId, job.owner); schedule(job); }
  }
  async function insertJob(input, options, previous) {
    ensureOpen(); const owner = ownerValue(options), { plan, request } = normalizeRequest(input, owner);
    const fields = new Set(['planId', 'planDigest', 'identity', 'acceptedItems', 'delivery', ...(previous ? ['retryItems'] : [])]);
    if (Object.keys(input).some(key => !fields.has(key))) throw bad('unsupported_job_field', 'The job request contains an unsupported field');
    let retryItems = null;
    if (previous) {
      if (!terminal.has(previous.status) || previous.status === 'ready') throw audioJobError(409, 'job_not_retryable', 'Only incomplete terminal jobs can be retried');
      if (!same(request, previous.request)) throw audioJobError(409, 'retry_selection_mismatch', 'A retry must use the original confirmed plan and selection');
      const candidates = previous.components.filter(item => ['failed', 'cancelled'].includes(item.status) && item.error?.retryable !== false).map(item => item.id);
      retryItems = input.retryItems === undefined ? candidates : input.retryItems;
      if (!Array.isArray(retryItems) || !retryItems.length || retryItems.some(id => typeof id !== 'string')) throw bad('invalid_retry_items', 'Select at least one retryable failed component');
      retryItems = [...new Set(retryItems)].sort();
      if (retryItems.some(id => !candidates.includes(id))) throw bad('item_not_retryable', 'Only failed retryable or cancelled components can be retried');
    }
    const selected = { planDigest: plan.planDigest, acceptedItems: request.acceptedItems, delivery: request.delivery };
    const key = idempotencyFor(owner, plan.identity.projectId, options?.idempotencyKey, { request, retryOf: previous?.id || null, retryItems });
    const existing = idempotency.get(key.scope);
    if (existing) {
      if (existing.requestDigest !== key.requestDigest) throw audioJobError(409, 'idempotency_conflict', 'This Idempotency-Key was already used for a different request');
      return { job: publicJob(ownedJob(existing.id, owner)), replayed: true };
    }
    const pending = [...jobs.values()].filter(job => !terminal.has(job.status));
    if (pending.length >= maxQueued || pending.filter(job => job.owner === owner).length >= maxQueuedPerOwner) throw audioJobError(429, 'queue_capacity_exceeded', 'Audio rendering queue is full; retry after current jobs complete', { retryable: true });
    const now = new Date().toISOString(), id = randomUUID();
    const job = { schemaVersion: 1, id, owner, request, selectionDigest: hash(selected), idempotency: key, status: 'queued', createdAt: now, updatedAt: now, packageId: null, publishedItemIds: [],
      components: request.acceptedItems.map(itemId => {
        const item = plan.items.find(value => value.id === itemId), old = previous?.components.find(value => value.id === itemId);
        return old && !retryItems?.includes(itemId) ? copy(old) : { id: itemId, kind: item.kind, required: item.required, status: 'queued', attempts: 0, cacheHit: false, error: null };
      }), ...(previous ? { retryOf: previous.id, retryItems } : {}) };
    await persist(job); jobs.set(id, job); idempotency.set(key.scope, { id, requestDigest: key.requestDigest }); schedule(job);
    return { job: publicJob(job), replayed: false };
  }
  const store = {
    async initialize() { return store; },
    async savePlan(input, options) {
      const owner = ownerValue(options), plan = copy(validatePlan(input));
      return transaction(async () => { ensureOpen(); const key = planKey(owner, plan.planId), existing = plans.get(key); if (existing && !same(existing, plan)) throw audioJobError(409, 'plan_conflict', 'An immutable plan cannot be changed'); if (!existing) { await writeJson(planPath(owner, plan.planId), { schemaVersion: 1, owner, plan }); plans.set(key, plan); } return copy(plan); });
    },
    async getPlan(id, options) { return copy(ownedPlan(id, ownerValue(options))); },
    async createJob(request, options) { return transaction(() => insertJob(request, options)); },
    async getJob(id, options) { return publicJob(ownedJob(id, ownerValue(options))); },
    async cancelJob(id, options) {
      const owner = ownerValue(options);
      return transaction(async () => {
        ensureOpen(); const job = ownedJob(id, owner); if (terminal.has(job.status)) return publicJob(job);
        job.status = 'cancelled'; job.updatedAt = new Date().toISOString(); job.completedAt = job.updatedAt;
        for (const item of job.components) if (['queued', 'rendering'].includes(item.status)) { item.status = 'cancelled'; item.error = { code: 'cancelled', message: 'Audio component was cancelled', retryable: true, componentId: item.id }; }
        await persist(job); active.get(id)?.controller.abort(audioJobError(409, 'cancelled', 'Audio job was cancelled', { retryable: true })); return publicJob(job);
      });
    },
    async retryJob(id, request, options) { const owner = ownerValue(options); return transaction(() => insertJob(request, options, ownedJob(id, owner))); },
    async getPackage(digest, options) {
      const owner = ownerValue(options); if (!digestPattern.test(digest || '')) throw missing();
      const directory = packagePath(owner, digest); let manifest;
      try { manifest = await readJson(path.join(directory, 'manifest.json')); } catch (error) { if (error.code === 'ENOENT') throw missing(); throw error; }
      const { packageId, ...core } = manifest;
      if (packageId !== digest || hash(core) !== digest) throw audioJobError(500, 'package_integrity_error', 'Stored package identity is invalid', { retryable: false });
      return { manifest: copy(manifest), directory };
    },
    async close() {
      if (drainPromise) return drainPromise;
      closing = true;
      for (const { controller } of active.values()) controller.abort(audioJobError(503, 'store_closed', 'Audio service is stopping', { retryable: true }));
      drainPromise = (async () => {
        await transaction(async () => {
          for (const job of jobs.values()) if (!terminal.has(job.status)) {
            job.status = 'queued'; job.updatedAt = new Date().toISOString();
            for (const item of job.components) if (item.status === 'rendering') { item.status = 'queued'; item.error = null; }
            await persist(job);
          }
        });
        let timeout;
        try { await Promise.race([Promise.allSettled([...active.values()].map(value => value.promise)), new Promise(resolve => { timeout = setTimeout(resolve, 1500); })]); }
        finally { clearTimeout(timeout); }
        await mutationTail; closed = true; await lease.release();
      })();
      return drainPromise;
    }
  };
  try { await restore(); } catch (error) { closing = true; closed = true; await lease.release(); throw error; }
  return store;
}
