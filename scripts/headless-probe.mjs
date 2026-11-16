import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium, origin } from './browser-runtime.mjs';

// Dedicated Web Audio execution harness. It never attaches to user browser state.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(root, 'artifacts/headless-probe.json');
const report = { createdAt: new Date().toISOString(), origin, purpose: 'Independent Chromium OfflineAudioContext performance and WAV decode probe', console: [], errors: [] };
let browser;
try {
  const chromium = await loadChromium();
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-background-timer-throttling'] });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('console', message => report.console.push({ type: message.type(), text: message.text(), at: Date.now() }));
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('requestfailed', request => report.errors.push(`requestfailed ${request.url()}: ${request.failure()?.errorText}`));
  await page.goto(report.origin, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__audioLab?.ready, null, { timeout: 10000 });
  report.nativeDecode = await page.evaluate(async () => {
    const response = await fetch('/assets/sfx/ui.wav');
    const bytes = await response.arrayBuffer();
    const context = new AudioContext();
    const result = { status: response.status, contentLength: response.headers.get('content-length'), bytes: bytes.byteLength, header: String.fromCharCode(...new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength))) };
    try {
      const decoded = await Promise.race([context.decodeAudioData(bytes), new Promise((_, reject) => setTimeout(() => reject(new Error('decodeAudioData timed out after 5s')), 5000))]);
      result.pass = true; result.duration = decoded.duration; result.sampleRate = decoded.sampleRate; result.channels = decoded.numberOfChannels;
    } catch (error) { result.pass = false; result.error = String(error?.message || error); }
    finally { await context.close(); }
    return result;
  });
  const started = Date.now();
  await page.evaluate(() => {
    window.__headlessProbe = { done: false, startedAt: performance.now(), phase: 'rendering' };
    window.__audioLab.renderExample('cozy', { mode: 'synth', seed: 1701 }).then(async rendered => {
      const result = window.__headlessProbe;
      result.renderMs = performance.now() - result.startedAt;
      result.phase = 'exporting'; result.stats = rendered.stats;
      const bytes = window.__audioLab.encodeWav(rendered.buffer);
      result.exportBytes = bytes.byteLength;
      const response = await fetch('/api/artifacts?name=cozy-synth-headless.wav', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: bytes });
      result.uploadStatus = response.status; result.uploadBody = await response.text();
      result.phase = 'complete'; result.pass = response.ok; result.done = true;
    }).catch(error => { Object.assign(window.__headlessProbe, { done: true, pass: false, phase: 'failed', error: String(error?.stack || error) }); });
  });
  try { await page.waitForFunction(() => window.__headlessProbe?.done === true, null, { timeout: 60000, polling: 250 }); }
  catch (error) { report.timeout = true; report.waitError = String(error.message); }
  report.elapsedMs = Date.now() - started;
  report.render = await page.evaluate(() => window.__headlessProbe);
  report.application = await page.evaluate(() => window.__audioLab.getState());
  await page.screenshot({ path: path.join(root, 'artifacts/headless-probe.png'), fullPage: true }).catch(error => { report.screenshotError = error.message; });
  const exported = path.join(root, 'artifacts/cozy-synth-headless.wav');
  if (fs.existsSync(exported)) report.exportedFileBytes = fs.statSync(exported).size;
  report.pass = report.nativeDecode.pass === true && report.render.pass === true && !report.timeout;
  process.exitCode = report.pass ? 0 : 1;
} catch (error) {
  report.fatal = String(error.stack || error); report.pass = false; process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
}
