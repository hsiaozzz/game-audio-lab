import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadChromium, origin } from './browser-runtime.mjs';
import { directPrompt, EXAMPLE_PROMPTS } from '../src/director.mjs';
import { composeScore } from '../src/composer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'artifacts');
const reportPath = path.join(artifacts, 'render-suite.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const report = {
  schemaVersion: 1, createdAt: new Date().toISOString(), origin, seed: 1701,
  purpose: 'Independent native Web Audio execution suite; musical quality still requires listening.',
  sourceHashes: Object.fromEntries(['src/director.mjs', 'src/composer.mjs', 'src/audio-engine.mjs', 'assets/manifest.json'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))])),
  results: {}, console: [], errors: [],
  notes: ['Cozy A/B uses an identical 1701 score; synthesis noise itself is not claimed bit-identical.', 'A previous complete cozy synth export may be reused and is labelled in the result.', 'All new renders run in a dedicated Chromium process, not in a user browser.']
};
const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
function inspectWav(file) {
  const data = fs.readFileSync(file);
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV export ' + file);
  const bytes = data.length, declaredBytes = data.readUInt32LE(4) + 8;
  if (bytes !== declaredBytes) throw new Error('Truncated WAV export ' + file);
  return { bytes, sha256: hash(data), sampleRate: data.readUInt32LE(24), channels: data.readUInt16LE(22), bitsPerSample: data.readUInt16LE(34) };
}
function writeResult(key, value) {
  fs.writeFileSync(path.join(artifacts, `${key}-score-stats.json`), JSON.stringify(value, null, 2));
  report.results[key] = value; save();
}

let browser;
try {
  const chromium = await loadChromium();
  // Preserve the earlier prompt-derived-seed comparison before the formal fixed-seed A/B.
  for (const [source, destination] of [['cozy-hybrid.wav', 'cozy-hybrid-promptseed.wav'], ['cozy-hybrid-stats.json', 'cozy-hybrid-promptseed-stats.json']]) {
    const from = path.join(artifacts, source), to = path.join(artifacts, destination);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
  }
  const baselinePath = path.join(artifacts, 'headless-probe.json');
  if (fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const from = path.join(artifacts, 'cozy-synth-headless.wav');
    if (baseline.pass === true && fs.existsSync(from)) {
      const score = composeScore(directPrompt(EXAMPLE_PROMPTS.find(item => item.id === 'cozy').prompt, { seed: 1701 }));
      const destination = path.join(artifacts, 'cozy-synth.wav'); fs.copyFileSync(from, destination);
      writeResult('cozy-synth', { pass: true, reused: true, reusedFrom: 'headless-probe.json / cozy-synth-headless.wav', originalCreatedAt: baseline.createdAt, score, scoreSha256: hash(JSON.stringify(score)), stats: baseline.render.stats, file: 'cozy-synth.wav', wav: inspectWav(destination) });
      console.log('REUSED cozy-synth ' + baseline.render.stats.renderMs.toFixed(0) + 'ms');
    }
  }
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-background-timer-throttling'] });
  report.browserVersion = browser.version(); save();
  const jobs = [{ id: 'cozy', mode: 'synth' }, { id: 'cozy', mode: 'hybrid' }, { id: 'neon', mode: 'synth' }, { id: 'ruins', mode: 'synth' }];
  for (const job of jobs) {
    const key = `${job.id}-${job.mode}`;
    if (report.results[key]?.pass) continue;
    console.log('START ' + key); const started = Date.now();
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await context.newPage();
      page.on('console', message => { if (['error', 'warning'].includes(message.type())) report.console.push({ key, type: message.type(), text: message.text() }); });
      page.on('pageerror', error => report.errors.push({ key, error: error.message }));
      await page.goto(origin, { waitUntil: 'load', timeout: 15000 });
      await page.waitForFunction(() => window.__audioLab?.ready, null, { timeout: 10000 });
      await page.evaluate(({ id, mode, key }) => {
        window.__suiteJob = { done: false, phase: 'rendering', startedAt: performance.now() };
        window.__audioLab.renderExample(id, { mode, seed: 1701 }).then(async rendered => {
          const result = window.__suiteJob; result.renderMs = performance.now() - result.startedAt;
          result.stats = rendered.stats; result.score = rendered.score; result.phase = 'exporting';
          const bytes = window.__audioLab.encodeWav(rendered.buffer);
          const response = await fetch(`/api/artifacts?name=${key}.wav`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: bytes });
          result.upload = { status: response.status, body: await response.text(), bytes: bytes.byteLength };
          result.pass = response.ok && rendered.stats.nonfinite === 0 && rendered.stats.clippedSamples === 0 && rendered.stats.peak > .001;
          result.phase = 'complete'; result.done = true;
        }).catch(error => { Object.assign(window.__suiteJob, { done: true, pass: false, phase: 'failed', error: String(error?.stack || error) }); });
      }, { ...job, key });
      try { await page.waitForFunction(() => window.__suiteJob?.done, null, { timeout: 90000, polling: 300 }); }
      catch (error) { throw new Error(`${key} did not complete in 90 seconds: ${error.message}`); }
      const result = await page.evaluate(() => window.__suiteJob);
      if (!result.pass) throw new Error(`${key} failed: ${JSON.stringify(result)}`);
      result.elapsedMs = Date.now() - started; result.file = `${key}.wav`; result.wav = inspectWav(path.join(artifacts, result.file)); result.scoreSha256 = hash(JSON.stringify(result.score));
      writeResult(key, result);
      console.log('DONE ' + key + ' ' + result.renderMs.toFixed(0) + 'ms peak=' + result.stats.peakDbFS.toFixed(2) + 'dBFS');
    } finally { await context.close(); }
  }
  const a = report.results['cozy-synth'], b = report.results['cozy-hybrid'];
  report.sameSeedAbScoreIdentical = a.scoreSha256 === b.scoreSha256;
  if (!report.sameSeedAbScoreIdentical) throw new Error('Cozy A/B score mismatch');

  console.log('START sfx-showcase');
  const context = await browser.newContext();
  try {
    const page = await context.newPage(); await page.goto(origin, { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.__audioLab?.ready, null, { timeout: 10000 });
    const brief = composeScore(directPrompt(EXAMPLE_PROMPTS.find(item => item.id === 'cozy').prompt, { seed: 1701 })).brief;
    await page.evaluate(brief => {
      window.__suiteSfx = { done: false, startedAt: performance.now() };
      window.__audioLab.renderSfx(brief).then(async rendered => {
        const result = window.__suiteSfx; result.renderMs = performance.now() - result.startedAt; result.events = rendered.events; result.stats = rendered.stats;
        const bytes = window.__audioLab.encodeWav(rendered.buffer);
        const response = await fetch('/api/artifacts?name=sfx-showcase.wav', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: bytes });
        result.uploadStatus = response.status; result.uploadBody = await response.text();
        result.pass = response.ok && rendered.stats.nonfinite === 0 && rendered.stats.clippedSamples === 0; result.done = true;
      }).catch(error => Object.assign(window.__suiteSfx, { done: true, pass: false, error: String(error?.stack || error) }));
    }, brief);
    await page.waitForFunction(() => window.__suiteSfx?.done, null, { timeout: 90000, polling: 300 });
    const sfx = await page.evaluate(() => window.__suiteSfx); if (!sfx.pass) throw new Error('SFX render failed: ' + JSON.stringify(sfx));
    sfx.file = 'sfx-showcase.wav'; sfx.wav = inspectWav(path.join(artifacts, sfx.file)); writeResult('sfx-showcase', sfx);
    console.log('DONE sfx-showcase ' + sfx.renderMs.toFixed(0) + 'ms');
  } finally { await context.close(); }
  report.pass = report.sameSeedAbScoreIdentical && Object.values(report.results).every(result => result.pass);
  report.completedAt = new Date().toISOString(); save(); process.exitCode = report.pass ? 0 : 1;
} catch (error) {
  report.pass = false; report.fatal = String(error.stack || error); save(); console.error(report.fatal); process.exitCode = 1;
} finally { if (browser) await browser.close(); console.log(JSON.stringify({ reportPath, pass: report.pass, sameSeedAbScoreIdentical: report.sameSeedAbScoreIdentical, results: Object.fromEntries(Object.entries(report.results).map(([key, result]) => [key, { pass: result.pass, renderMs: result.renderMs ?? result.stats?.renderMs, duration: result.stats?.durationSeconds }])) }, null, 2)); }
