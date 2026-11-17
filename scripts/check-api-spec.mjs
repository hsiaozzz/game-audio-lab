import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAudioApi } from '../server/audio-api.mjs';
import { FORMATS, LIMITS } from '../server/audio-plan.mjs';
import { verifyManifest } from '../src/audio-service-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(await fs.readFile(path.join(root, 'docs/openapi.json'), 'utf8'));
const checks = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const resolve = reference => {
  assert(reference.startsWith('#/'), `External $ref is not supported by this check: ${reference}`);
  return reference.slice(2).split('/').reduce((value, key) => {
    assert(value && Object.hasOwn(value, key.replace(/~1/g, '/').replace(/~0/g, '~')), `Broken $ref: ${reference}`);
    return value[key.replace(/~1/g, '/').replace(/~0/g, '~')];
  }, spec);
};

// Deliberately scoped validator for the JSON Schema keywords used by this document.
// This is a runtime/document consistency check, not a claim of full OpenAPI certification.
function validate(schema, value, location = '$') {
  if (schema === true) return;
  if (schema === false) throw new Error(`${location}: forbidden value`);
  if (schema.$ref) validate(resolve(schema.$ref), value, location);
  if (schema.allOf) for (const branch of schema.allOf) validate(branch, value, location);
  const matches = branch => { try { validate(branch, value, location); return true; } catch { return false; } };
  if (schema.anyOf) assert(schema.anyOf.some(matches), `${location}: no anyOf branch matches`);
  if (schema.oneOf) assert.equal(schema.oneOf.filter(matches).length, 1, `${location}: expected exactly one oneOf branch`);
  if (schema.not) assert(!matches(schema.not), `${location}: forbidden schema matched`);
  if ('const' in schema) assert.deepEqual(value, schema.const, `${location}: const mismatch`);
  if (schema.enum) assert(schema.enum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value)), `${location}: enum mismatch`);
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert(types.some(expected => expected === type || expected === 'integer' && typeof value === 'number' && Number.isInteger(value)), `${location}: expected ${types.join('|')}, got ${type}`);
  }
  if (typeof value === 'number') {
    assert(Number.isFinite(value), `${location}: non-finite number`);
    if (schema.minimum !== undefined) assert(value >= schema.minimum, `${location}: below minimum`);
    if (schema.maximum !== undefined) assert(value <= schema.maximum, `${location}: above maximum`);
    if (schema.exclusiveMinimum !== undefined) assert(value > schema.exclusiveMinimum, `${location}: below exclusive minimum`);
    if (schema.exclusiveMaximum !== undefined) assert(value < schema.exclusiveMaximum, `${location}: above exclusive maximum`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert(value.length >= schema.minLength, `${location}: short string`);
    if (schema.maxLength !== undefined) assert(value.length <= schema.maxLength, `${location}: long string`);
    if (schema.pattern) assert(new RegExp(schema.pattern, 'u').test(value), `${location}: pattern mismatch`);
    if (schema.format === 'date-time') assert(Number.isFinite(Date.parse(value)), `${location}: invalid date-time`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, `${location}: too few items`);
    if (schema.maxItems !== undefined) assert(value.length <= schema.maxItems, `${location}: too many items`);
    if (schema.uniqueItems) assert.equal(new Set(value.map(item => JSON.stringify(item))).size, value.length, `${location}: duplicate items`);
    if (schema.items !== undefined) for (const [index, item] of value.entries()) validate(schema.items, item, `${location}[${index}]`);
  } else if (value && typeof value === 'object') {
    for (const key of schema.required || []) assert(Object.hasOwn(value, key), `${location}.${key}: missing required field`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames) validate(schema.propertyNames, key, `${location} key`);
      if (Object.hasOwn(schema.properties || {}, key)) validate(schema.properties[key], item, `${location}.${key}`);
      else if (schema.additionalProperties !== undefined) validate(schema.additionalProperties, item, `${location}.${key}`);
    }
  }
}

assert.equal(spec.openapi, '3.1.0');
assert.equal(spec.jsonSchemaDialect, 'https://json-schema.org/draft/2020-12/schema');
assert.equal(spec.components.securitySchemes.ServiceBearer.scheme, 'bearer');
const operationIds = new Set();
function walk(value) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) resolve(value.$ref);
  if (value.pattern) new RegExp(value.pattern, 'u');
  if (value.required && value.properties) for (const key of value.required) assert(Object.hasOwn(value.properties, key), `Undeclared required property: ${key}`);
  for (const child of Object.values(value)) walk(child);
}
walk(spec);
for (const [route, pathItem] of Object.entries(spec.paths)) {
  for (const method of ['get', 'post', 'delete', 'head', 'options']) {
    const operation = pathItem[method];
    if (!operation) continue;
    assert(!operationIds.has(operation.operationId), `Duplicate operationId: ${operation.operationId}`);
    operationIds.add(operation.operationId);
    assert(Object.keys(operation.responses || {}).some(status => /^2\d\d$/.test(status)), `No success response for ${method} ${route}`);
    const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])];
    for (const [,name] of route.matchAll(/\{([^}]+)\}/g)) assert(parameters.some(parameter => parameter.in === 'path' && parameter.name === name && parameter.required), `Undeclared path parameter ${name}`);
    const media = operation.requestBody?.content?.['application/json'];
    for (const example of Object.values(media?.examples || {})) validate(media.schema, example.value);
  }
}
assert.deepEqual(spec.components.schemas.FormatId.enum, FORMATS.map(format => format.id));
assert.deepEqual(Object.fromEntries(Object.entries(spec.components.schemas.CapabilitiesResponse.properties.limits.properties).map(([key, definition]) => [key, definition.const])), LIMITS);
checks.push('OpenAPI 3.1 metadata, local references, unique operations/path parameters, supported formats/limits and embedded examples');

const input = JSON.parse(await fs.readFile(path.join(root, 'examples/audio-service-request.json'), 'utf8'));
input.gameBrief.designTag = 'extension metadata remains in the shared brief hash';
input.audioRequests[0].spatial = { enabled: true, refDistance: 2, maxDistance: 60, rolloffFactor: .8, distanceModel: 'inverse' };
validate(spec.components.schemas.PlanRequest, input);
const temporaryRoot = path.resolve(os.tmpdir());
const directory = await fs.mkdtemp(path.join(temporaryRoot, 'audio-spec-check-'));
const token = 'spec-check-owner-token-at-least-24-characters';
const otherToken = 'spec-check-other-token-at-least-24-characters';
let failMusic = true;

// Contract-only fake bytes: this check never renders/decodes music or judges sound quality.
async function fakeRenderer({ item, directory: output, signal }) {
  signal.throwIfAborted();
  if (item.kind === 'music' && failMusic) {
    failMusic = false;
    throw Object.assign(new Error('intentional spec fixture failure'), { code: 'spec_fixture_failure', retryable: true });
  }
  const count = item.kind === 'sfx' ? item.variants : item.playback === 'stems' ? 3 : 1;
  const files = [];
  for (let index = 0; index < count; index++) {
    const bytes = Buffer.from(`NOT AUDIO: documentation contract fixture ${item.id} ${index}`);
    const filename = `fixture-${index + 1}.${item.formatId === 'opus-ogg' ? 'ogg' : 'm4a'}`;
    await fs.writeFile(path.join(output, filename), bytes);
    files.push({ id: `fixture-${index + 1}`, path: filename, sha256: digest(bytes), bytes: bytes.length,
      mimeType: item.formatId === 'opus-ogg' ? 'audio/ogg; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"',
      formatId: item.formatId, container: item.formatId === 'opus-ogg' ? 'ogg' : 'mp4', codec: item.formatId === 'opus-ogg' ? 'opus' : 'aac-lc',
      sampleRate: 48000, channels: item.channels, frames: 4800, decodedFrames: 4800, durationSeconds: .1, decodedPcmBytes: 4800 * item.channels * 4,
      encoding: { encoder: 'documentation-contract-fixture', version: '1', targetBitrateKbps: item.bitrateKbps, rateControl: 'vbr', profile: null },
      trim: { referenceSampleRate: 48000, masterFrames: 4800, leadingPaddingFrames: 0, trailingPaddingFrames: 0, startFrame: 0, endFrame: 4800, decodedFrames: 4800, priming: 'fake fixture, not encoded audio' } });
  }
  return { files, quality: { technical: 'passed', binding: 'contract-validated', listening: 'not-evaluated' }, provenance: { rendererVersion: 'documentation-contract-fixture', assets: [] },
    ...(item.kind === 'sfx' ? { sfx: { eventId: item.eventId, variants: files.map(file => file.id), maxRatePerSecond: item.maxRatePerSecond, spatial: item.spatial } }
      : { music: { scene: item.scene, gainDb: 0, loop: { enabled: item.loop, referenceSampleRate: 48000, startFrame: 0, endFrame: 4800 }, ...(item.playback === 'mix' ? { mixFileId: files[0].id } : { stemFileIds: files.map(file => file.id) }) } }) };
}

const api = await createAudioApi({ root, dataDir: directory, renderItem: fakeRenderer, env: {
  GAME_AUDIO_API_TOKENS_JSON: JSON.stringify({ owner: token, other: otherToken }), GAME_AUDIO_ALLOWED_ORIGINS: 'https://game.example'
} });
const server = http.createServer(async (req, res) => {
  if (!await api.handle(req, res, new URL(req.url, 'http://localhost'))) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let exchanges = 0;
async function request(routeTemplate, method = 'get', { parameters = {}, body, rawBody, authorization = token, headers = {}, expectedStatus = 200, invalidRequest = false } = {}) {
  const operation = spec.paths[routeTemplate]?.[method];
  assert(operation, `Operation absent from spec: ${method} ${routeTemplate}`);
  if (body !== undefined && !invalidRequest) validate(operation.requestBody.content['application/json'].schema, body);
  const route = routeTemplate.replace(/\{([^}]+)\}/g, (_, name) => name === 'filePath' ? parameters[name].split('/').map(encodeURIComponent).join('/') : encodeURIComponent(parameters[name]));
  const response = await fetch(origin + route, {
    method: method.toUpperCase(), headers: { ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
  });
  assert.equal(response.status, expectedStatus, `${method} ${route}`);
  const definition = operation.responses[response.status];
  assert(definition, `Undocumented status ${response.status} for ${method} ${routeTemplate}`);
  let data;
  if (method !== 'head' && response.status !== 204 && response.status !== 304 && response.status !== 416) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (definition.content?.['application/json'] && response.headers.get('content-type')?.includes('application/json') && !routeTemplate.includes('/files/')) {
      data = JSON.parse(bytes.toString('utf8'));
      validate(definition.content['application/json'].schema, data);
    } else data = bytes;
  } else assert.equal((await response.arrayBuffer()).byteLength, 0, 'HEAD/preflight/304/416 must have no response body');
  for (const [name, header] of Object.entries(definition.headers || {})) {
    const value = response.headers.get(name);
    if (value !== null) validate(header.schema, header.schema?.type === 'integer' ? Number(value) : value, `header ${name}`);
  }
  exchanges++;
  return { data, headers: response.headers, status: response.status };
}
async function terminal(jobId) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const { data } = await request('/v1/audio/jobs/{jobId}', 'get', { parameters: { jobId } });
    if (['ready', 'partial-ready', 'failed', 'cancelled'].includes(data.job.status)) return data.job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Documentation fixture job did not finish');
}
try {
  await request('/v1/audio/health');
  await request('/v1/audio/capabilities');
  await request('/v1/audio/capabilities', 'get', { authorization: null, expectedStatus: 401 });
  await request('/v1/audio/capabilities', 'get', { headers: { Origin: 'https://denied.example' }, expectedStatus: 403 });
  const preflight = await request('/v1/audio/plans', 'options', { authorization: null, headers: { Origin: 'https://game.example' }, expectedStatus: 204 });
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://game.example');
  checks.push('live health/capability response schemas, Bearer errors and exact-origin CORS/preflight');

  const { data: { plan } } = await request('/v1/audio/plans', 'post', { body: input, expectedStatus: 201 });
  assert.equal(plan.sourcePlan.gameBrief.designTag, input.gameBrief.designTag);
  assert.equal(plan.items.find(item => item.kind === 'sfx').spatial.enabled, true);
  await request('/v1/audio/plans/{planId}', 'get', { parameters: { planId: plan.planId } });
  await request('/v1/audio/plans/{planId}', 'get', { parameters: { planId: plan.planId }, authorization: otherToken, expectedStatus: 404 });
  await request('/v1/audio/plans', 'post', { body: { ...input, owner: 'spoofed' }, invalidRequest: true, expectedStatus: 422 });
  assert.throws(() => validate(spec.components.schemas.PlanRequest, { ...input, owner: 'spoofed' }));
  await request('/v1/audio/plans', 'post', { rawBody: 'not json', headers: { 'Content-Type': 'text/plain' }, expectedStatus: 415 });
  await request('/v1/audio/plans', 'post', { rawBody: '{', headers: { 'Content-Type': 'application/json' }, expectedStatus: 400 });
  await request('/v1/audio/plans', 'post', { rawBody: JSON.stringify({ data: 'x'.repeat(LIMITS.requestBytes) }), headers: { 'Content-Type': 'application/json' }, expectedStatus: 413 });
  checks.push('actual 201 plan/read schemas with spatial config and shared metadata, owner isolation, strict envelopes and JSON/body-size errors');

  const confirmation = { planId: plan.planId, planDigest: plan.planDigest, identity: plan.identity, acceptedItems: plan.items.map(item => item.id), delivery: plan.delivery };
  const { data: submitted, headers: submitHeaders } = await request('/v1/audio/jobs', 'post', { body: confirmation, headers: { 'Idempotency-Key': 'spec-original' }, expectedStatus: 202 });
  assert.equal(submitHeaders.get('location'), submitted.job.statusUrl);
  const replay = await request('/v1/audio/jobs', 'post', { body: confirmation, headers: { 'Idempotency-Key': 'spec-original' } });
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.job.id, submitted.job.id);
  await request('/v1/audio/jobs', 'post', { body: confirmation, expectedStatus: 400 });
  await request('/v1/audio/jobs', 'post', { body: { ...confirmation, owner: 'spoofed' }, headers: { 'Idempotency-Key': 'spec-spoof' }, expectedStatus: 400, invalidRequest: true });
  await request('/v1/audio/jobs', 'post', { body: { ...confirmation, delivery: { ...confirmation.delivery, quality: 'high' } }, headers: { 'Idempotency-Key': 'spec-mismatch' }, expectedStatus: 409 });
  const partial = await terminal(submitted.job.id);
  assert.equal(partial.status, 'partial-ready');
  assert.equal(partial.allSelectedReady, false);
  assert(partial.packageId && partial.manifestUrl);
  await request('/v1/audio/jobs/{jobId}', 'get', { parameters: { jobId: partial.id }, authorization: otherToken, expectedStatus: 404 });
  checks.push('202 new job vs 200 replay envelopes/Location, strict confirmation, component error and partial-ready response schemas');

  const { data: oldManifest } = await request('/v1/audio/packages/{packageId}/manifest', 'get', { parameters: { packageId: partial.packageId } });
  await verifyManifest(oldManifest, { expectedIdentity: plan.identity, planId: plan.planId, planDigest: plan.planDigest, selectionDigest: partial.selectionDigest });
  await request('/v1/audio/packages/{packageId}/manifest', 'head', { parameters: { packageId: partial.packageId } });
  await request('/v1/audio/packages/{packageId}/manifest', 'get', { parameters: { packageId: partial.packageId }, authorization: otherToken, expectedStatus: 404 });
  const audio = oldManifest.files.find(file => file.kind === 'sfx');
  const parameters = { packageId: oldManifest.packageId, filePath: audio.path };
  const full = await request('/v1/audio/packages/{packageId}/files/{filePath}', 'get', { parameters });
  assert.equal(digest(full.data), audio.sha256);
  assert.equal(full.data.length, audio.bytes);
  const range = await request('/v1/audio/packages/{packageId}/files/{filePath}', 'get', { parameters, headers: { Range: 'bytes=1-7' }, expectedStatus: 206 });
  assert.deepEqual(range.data, full.data.subarray(1, 8));
  await request('/v1/audio/packages/{packageId}/files/{filePath}', 'head', { parameters, headers: { Range: 'bytes=-4' }, expectedStatus: 206 });
  await request('/v1/audio/packages/{packageId}/files/{filePath}', 'head', { parameters });
  await request('/v1/audio/packages/{packageId}/files/{filePath}', 'get', { parameters, headers: { 'If-None-Match': full.headers.get('etag') }, expectedStatus: 304 });
  await request('/v1/audio/packages/{packageId}/files/{filePath}', 'get', { parameters, headers: { Range: 'bytes=999999999-' }, expectedStatus: 416 });
  await request('/v1/audio/packages/{packageId}/files/{filePath}', 'get', { parameters: { ...parameters, filePath: oldManifest.provenance.licensesPath } });
  checks.push('manifest schemas and SDK digest validation, listed audio/provenance bytes, HEAD, 206 Range, 304 ETag and empty-body 416');

  const retry = await request('/v1/audio/jobs/{jobId}/retry', 'post', { parameters: { jobId: partial.id }, body: { ...confirmation, retryItems: partial.components.filter(item => item.status === 'failed').map(item => item.id) }, headers: { 'Idempotency-Key': 'spec-retry' }, expectedStatus: 202 });
  const ready = await terminal(retry.data.job.id);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.retryOf, partial.id);
  assert.equal(ready.allSelectedReady, true);
  const { data: readyManifest } = await request('/v1/audio/packages/{packageId}/manifest', 'get', { parameters: { packageId: ready.packageId } });
  await verifyManifest(readyManifest);
  const old = await request('/v1/audio/packages/{packageId}/manifest', 'get', { parameters: { packageId: oldManifest.packageId } });
  assert.deepEqual(old.data, oldManifest);
  const cancel = await request('/v1/audio/jobs/{jobId}', 'delete', { parameters: { jobId: ready.id } });
  assert.equal(cancel.data.job.status, 'ready', 'Cancelling terminal ready work is idempotent');
  await request('/v1/audio/jobs/{jobId}/retry', 'post', { parameters: { jobId: ready.id }, body: confirmation, headers: { 'Idempotency-Key': 'spec-invalid-retry' }, expectedStatus: 409 });
  checks.push('retry creates a typed new job, preserves old packages, delivers typed music mapping and idempotent terminal cancellation');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await api.close();
  const absolute = path.resolve(directory);
  assert(absolute.startsWith(temporaryRoot + path.sep), 'Temporary cleanup escaped OS temp directory');
  await fs.rm(absolute, { recursive: true, force: true });
}
console.log(JSON.stringify({ pass: true, checks, exchanges, verification: 'Live API/schema contract checks with fake media bytes; no audio rendering/listening claim.' }, null, 2));
