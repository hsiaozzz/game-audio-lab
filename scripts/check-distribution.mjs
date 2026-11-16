import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file));
const json = file => JSON.parse(read(file).toString('utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = json('assets/manifest.json');
const samples = [...manifest.samples, ...Object.values(manifest.instruments).flatMap(instrument => instrument.samples)];
let sampleBytes = 0;
for (const sample of samples) {
  assert.match(sample.url, /^\/assets\/(sfx|instruments)\/[A-Za-z0-9/_.-]+\.wav$/);
  const bytes = read(sample.url.slice(1));
  assert.equal(hash(bytes), sample.sha256, `${sample.url} hash mismatch`);
  assert.equal(bytes.length, sample.bytes, `${sample.url} size mismatch`);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  sampleBytes += bytes.length;
}
assert.equal(samples.length, 17);
const tone = json('vendor/provenance.json');
assert.equal(tone.version, '15.1.22');
assert.equal(tone.bundleSha256, 'e290952fa43d9a7a780182a83c6fccf44d79cb7ae2cba102ef1f2b9d98124e22');
assert.equal(hash(read('vendor/Tone.js')), tone.bundleSha256);
for (const file of ['vendor/Tone.LICENSE.md', 'vendor/Tone.js.LICENSE.txt', 'assets/licenses/Kenney-CC0.md', 'assets/licenses/VSCO-CC0.txt']) assert.ok(read(file).length, file);
const listenPage = read('listen.html').toString('utf8');
const listenFiles = [...new Set([...listenPage.matchAll(/(?:src|href)="\/(artifacts\/[^"?]+\.mp3)"/g)].map(match => match[1]))];
assert.equal(listenFiles.length, 9);
for (const file of listenFiles) assert.ok(read(file).length > 1000, `Missing demo audio: ${file}`);
const comparison = json('artifacts/sfx-comparison.json');
for (const variant of ['synth', 'reference']) {
  const bytes = read(`artifacts/sfx-${variant}-matched.wav`);
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
}
assert.equal(comparison.spacingSeconds, 1.8);
// Catch missing page assets and local module imports in a clone or an extracted ZIP.
const sitePages = ['index.html', 'listen.html', 'blind.html', 'pipeline.html'];
const requiredFiles = new Set(['src/game-audio-pipeline.mjs', 'src/game-audio-bridge.mjs']);
const localReference = (reference, from) => {
  const base = new URL(from, 'https://distribution.invalid/');
  const url = new URL(reference, base);
  if (url.origin !== base.origin) return null;
  const relative = decodeURIComponent(url.pathname).slice(1) || 'index.html';
  const target = path.resolve(root, relative);
  assert.ok(target.startsWith(root + path.sep), `Resource escapes distribution: ${reference}`);
  return relative;
};
for (const page of sitePages) {
  requiredFiles.add(page);
  for (const match of read(page).toString('utf8').matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const file = localReference(match[1], page);
    if (file) requiredFiles.add(file);
  }
}
for (const file of requiredFiles) {
  const contents = read(file);
  assert.ok(contents.length, `Empty distribution resource: ${file}`);
  if (/\.m?js$/.test(file)) {
    for (const match of contents.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const dependency = localReference(match[1], file);
      if (dependency) requiredFiles.add(dependency);
    }
  }
}
console.log(JSON.stringify({ pass: true, samples: samples.length, sampleBytes, toneVersion: tone.version, listenFiles: listenFiles.length, blindSources: 2, sitePages: sitePages.length, localResources: requiredFiles.size }));
