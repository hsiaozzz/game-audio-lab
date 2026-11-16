import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(root, 'artifacts/audio-engine-validation.json');
const origin = process.env.GAME_AUDIO_ORIGIN || 'http://127.0.0.1:4178';
const report = { createdAt: new Date().toISOString(), script: 'scripts/check-audio-engine.mjs', origin, purpose: 'Dedicated Chromium Web Audio API lifecycle, validation, silent-stem and SFX baseline checks.', caveat: 'Technical QA only. No full BGM render and no subjective quality score.', pageErrors: [], pass: false };
let browser;
try {
  const moduleName = process.env.GAME_AUDIO_PLAYWRIGHT;
  const { chromium } = await import(moduleName ? pathToFileURL(path.resolve(moduleName)).href : 'playwright');
  const engineSource=await fs.readFile(path.join(root,'src/audio-engine.mjs'),'utf8'),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  report.engineSha256=hash(engineSource);
  report.sfxRecipeSha256=hash(engineSource.slice(engineSource.indexOf('function sfxVoice('),engineSource.indexOf('export async function renderSfxReel(')));
  report.instrumentDefinitionsSha256=hash(engineSource.slice(engineSource.indexOf('function instrumentFor('),engineSource.indexOf('function makeImpulse(')));
  report.sampleHashes=[];
  const manifest=JSON.parse(await fs.readFile(path.join(root,'assets/manifest.json'),'utf8'));
  for(const sample of manifest.samples){const actualSha256=hash(await fs.readFile(path.join(root,sample.url.replace(/^[/\\]+/,''))));report.sampleHashes.push({id:sample.id,expectedSha256:sample.sha256,actualSha256,match:actualSha256===sample.sha256});if(actualSha256!==sample.sha256)throw new Error(`Prepared sample hash differs from manifest: ${sample.id}`);}
  const baselineHashes = {}, missingBaselineModes = [];
  for (const mode of ['synth', 'reference', 'hybrid']) {
    try {
      const bytes = await fs.readFile(path.join(root, `artifacts/sfx-${mode}-raw.wav`));
      baselineHashes[mode] = createHash('sha256').update(bytes).digest('hex');
    } catch(error) {
      if(error.code!=='ENOENT')throw error;
      missingBaselineModes.push(mode);
    }
  }
  // These research WAVs are optional and are not included in a normal Git clone.
  // Compare all three routes together, or explicitly skip the entire comparison.
  report.baselineComparison = missingBaselineModes.length
    ? { status:'skipped',executed:false,reason:'One or more optional raw SFX baseline WAVs are absent; all three baseline comparisons are skipped.',missingModes:missingBaselineModes,availableModes:Object.keys(baselineHashes) }
    : { status:'pending',executed:false,missingModes:[],availableModes:Object.keys(baselineHashes) };
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  report.browserVersion = browser.version();
  const page = await browser.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(origin, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => !!globalThis.Tone, null, { timeout: 10000 });
  report.result = await page.evaluate(async ({expectedHashes,baselineAvailability}) => {
    const { createAudioRuntime, renderScore, renderSfxComparison, encodeWav } = await import('/src/audio-engine.mjs');
    const checks = [], contexts = [], runtimes = [];
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const rejects = async (operation, pattern) => {
      try { await operation(); } catch (error) { assert(pattern.test(error.message), `Unexpected error: ${error.message}`); return error.message; }
      throw new Error('Expected operation to reject');
    };
    const NativeAudioContext = globalThis.AudioContext, originalFetch = globalThis.fetch, originalTone = globalThis.Tone, originalOffline = Tone.Offline, originalToneContext = Tone.getContext();
    let bankRequests = 0, offlineCalls = 0;
    globalThis.AudioContext = class extends NativeAudioContext { constructor(options) { super(options); contexts.push(this); } };
    globalThis.fetch = (...args) => { if (String(args[0]) === '/api/sound-bank') bankRequests++; return originalFetch(...args); };
    globalThis.Tone = { ...originalTone, Offline: (...args) => { offlineCalls++; return originalOffline(...args); } };
    const runtime = () => { const result = createAudioRuntime(); runtimes.push(result); return result; };
    const makeBuffer = (duration = .09) => { const result = new AudioBuffer({ length: Math.round(duration * 44100), numberOfChannels: 2, sampleRate: 44100 }); for (let channel = 0; channel < 2; channel++) { const data = result.getChannelData(channel); for (let index = 0; index < data.length; index++) data[index] = Math.sin(2 * Math.PI * 330 * index / 44100) * .03; } return result; };
    const score = style => ({ brief: { style, rootMidi: 62, mode: 'major' }, duration: .12, bpm: 120, tracks: [{ id: 'test-kick', role: 'drums', instrument: 'kick', pan: 0, gainDb: -17, events: [{ beat: 0, durationBeats: .06, midi: 36, velocity: .54 }] }] });
    const observations = {};
    try {
      const a = runtime(), b = runtime();
      await Promise.all([a.unlock(), b.unlock()]);
      assert(contexts.length === 2 && contexts[0] !== contexts[1], 'Runtimes did not create separate owned contexts');
      assert(Tone.getContext() === originalToneContext, 'Realtime unlock changed Tone global context');
      await a.dispose(); await a.dispose();
      assert(contexts[0].state === 'closed' && contexts[1].state === 'running', 'Disposing one runtime closed another');
      await b.play(makeBuffer(), { loop: false }); await wait(180);
      const ended = b.getState();
      assert(!ended.playing && ended.activeSources === 0 && Math.abs(ended.position - .09) < 1e-8, 'Nonloop natural end state was incorrect');
      assert(bankRequests === 0, 'Playing rendered music unnecessarily fetched the sound bank');
      await rejects(() => a.unlock(), /disposed/); await rejects(() => a.playEvent('ui'), /disposed/);
      checks.push('owned realtime contexts are isolated', 'dispose is idempotent and terminal', 'another runtime remains usable after disposal', 'nonloop natural end', 'music playback does not require sound-bank fetch');
      observations.nonloop = ended;

      const c = runtime(), buffer = makeBuffer(.3), pendingPlay = c.play(buffer);
      c.stop(); assert(await pendingPlay === false && !c.getState().playing, 'Stop did not cancel pending play');
      await c.play(buffer); c.pause(); assert(c.getState().paused && !c.getState().playing, 'Pause state incorrect');
      await c.resume(); assert(c.getState().playing && !c.getState().paused, 'Resume state incorrect');
      await rejects(() => c.play(null), /buffer/);
      await rejects(() => c.play({ stems: { core: buffer, texture: makeBuffer(.1) } }), /matching/);
      assert(c.getState().playing, 'Invalid playback input interrupted existing music');
      const oldIntensity = c.getState().intensity;
      await rejects(() => c.setIntensity(NaN), /finite/); await rejects(() => c.setIntensity(null), /finite/);
      assert(c.getState().intensity === oldIntensity, 'Invalid intensity poisoned runtime state');
      await rejects(() => c.playEvent(null), /event ID/); await rejects(() => c.playEvent('ui', { pan: NaN }), /finite/);
      c.stop(); await wait(35); assert(c.getState().retiringSources === 0, 'Stopped sources were retained');
      checks.push('pending play cancellation', 'pause/resume', 'invalid playback preserves current music', 'NaN/null input rejected without poisoning state', 'retiring source cleanup');

      const d = runtime(), inFlight = d.playEvent('charge'); const disposed = d.dispose();
      await rejects(() => inFlight, /disposed/); await disposed;
      assert(d.getState().disposed && d.getState().voiceCount === 0, 'Disposal did not cancel pending sound event');
      checks.push('dispose cancels in-flight unlock/event');

      const e = runtime(); await e.playEvent('charge');
      const voiceContext = contexts.at(-1); await voiceContext.suspend();
      await wait(1100); const suspended = e.getState();
      assert(suspended.voiceCount === 1 && voiceContext.state === 'suspended', 'Suspension prematurely released a sound tail');
      await voiceContext.resume(); await wait(1120); const released = e.getState();
      assert(released.voiceCount === 0 && released.retainedVoiceCount === 0, 'Expired voices retained nodes');
      observations.suspendedCharge = { after1100msWallClock: suspended.voiceCount, afterAudioClockResumed: released.voiceCount };
      const budget = await Promise.all(Array.from({ length: 13 }, () => e.playEvent('charge')));
      assert(budget.filter(result => result.accepted).length === 12 && budget.filter(result => result.reason === 'voice-budget').length === 1, 'Voice budget was exceeded');
      await e.dispose(); assert(e.getState().voiceCount === 0 && e.getState().retiringSources === 0 && e.getWaveform().length === 0, 'Dispose retained audio nodes');
      checks.push('suspended audio keeps its tail despite elapsed wall time', 'audio-clock voice cleanup', '12-voice budget under concurrent events', 'dispose releases voices, sources and analyser');

      await rejects(() => renderScore(null), /score/);
      await rejects(() => renderScore(score('unsupported')), /style/);
      await rejects(() => renderScore(score('cozy'), { mode: 'unknown' }), /mode/);
      await rejects(() => renderScore(score('cozy'), { sampleRate: NaN }), /sampleRate/);
      const invalid = score('cozy'); invalid.tracks[0].instrument = 'invalid-probe-instrument';
      await rejects(() => renderScore(invalid), /Unknown instrument/);
      assert(offlineCalls === 0, 'Invalid score allocated an offline renderer');
      const rendered = await renderScore(score('cozy'));
      assert(offlineCalls === 1 && rendered.stats.offlineStemCount === 1, `Empty-stem renderer count differs: calls=${offlineCalls}, stats=${JSON.stringify(rendered.stats)}`);
      assert(rendered.stats.skippedSilentStems.join(',') === 'core,texture', 'Silent-stem accounting is incorrect');
      assert(rendered.stats.peak > 0 && rendered.stats.nonfinite === 0, 'Recovery render is silent or nonfinite');
      assert(Tone.getContext() === originalToneContext, 'Short offline render did not restore Tone context');
      const f = runtime(), offlineContext = new Tone.OfflineContext(2, .1, 44100);
      try { Tone.setContext(offlineContext); await f.unlock(); assert(f.getState().contextState === 'running' && Tone.getContext() === offlineContext, 'Runtime borrowed or replaced an offline context'); }
      finally { Tone.setContext(originalToneContext); offlineContext.dispose(); }
      observations.shortScore = { stats: rendered.stats, toneContextRestored: true };
      checks.push('invalid score/style/mode/sampleRate fails before allocation', 'render queue recovers after validation error', 'two empty stems skip offline rendering', 'runtime unlock is independent of active Tone offline context');

      let baselineComparison={...baselineAvailability};
      const skippedChecks=[];
      if(baselineAvailability.status==='skipped'){
        observations.sfxBaseline={...baselineAvailability};
        skippedChecks.push({name:'SFX baseline comparison',reason:baselineAvailability.reason,missingModes:baselineAvailability.missingModes});
      }else{
        const comparison = await renderSfxComparison({ rootMidi: 62, mode: 'major' });
        observations.sfxBaseline = {};let baselinePass=true;
        for (const [mode, reel] of Object.entries(comparison.reels)) {
          const encoded=encodeWav(reel.buffer),digest = await crypto.subtle.digest('SHA-256', encoded);
          const actualSha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
          const response=await fetch(`/artifacts/sfx-${mode}-raw.wav`);assert(response.ok,`Available ${mode} baseline could not be fetched`);
          const existing=await response.arrayBuffer(),before=new Int16Array(existing,44),after=new Int16Array(encoded,44);
          let maxDifference=0,changedSamples=0,differenceSquares=0;
          for(let index=0;index<Math.min(before.length,after.length);index++){const delta=Math.abs(before[index]-after[index]);maxDifference=Math.max(maxDifference,delta);if(delta)changedSamples++;differenceSquares+=delta*delta;}
          const exactMatch=actualSha256===expectedHashes[mode],withinCrossBrowserRounding=before.length===after.length&&maxDifference<=1;baselinePass=baselinePass&&withinCrossBrowserRounding;
          observations.sfxBaseline[mode] = { expectedSha256: expectedHashes[mode], actualSha256, exactMatch, matchingSampleCount:before.length===after.length, maxDifferencePcm16LSB:maxDifference,changedSamples,rmsDifferencePcm16LSB:Math.sqrt(differenceSquares/after.length),withinCrossBrowserRounding,acceptance:'Equal sample count and every PCM16 sample differs by at most one LSB from the existing Ego-rendered baseline; exact hashes are reported separately.' };
        }
        baselineComparison={...baselineAvailability,status:baselinePass?'passed':'failed',executed:true};
        if(baselinePass)checks.push('existing SFX baseline preserved within one PCM16 LSB across browsers; exact hashes retained separately');
      }
      // Aggregate pass covers executed checks only; skipped checks have no pass flag.
      return { pass:baselineComparison.status!=='failed',checks,executedCheckCount:checks.length,skippedChecks,baselineComparison,observations,contextCount:contexts.length,bankRequests };
    } finally {
      for (const item of runtimes) await item.dispose().catch(() => {});
      globalThis.AudioContext = NativeAudioContext; globalThis.fetch = originalFetch; globalThis.Tone = originalTone; Tone.setContext(originalToneContext);
    }
  }, {expectedHashes:baselineHashes,baselineAvailability:report.baselineComparison});
  report.baselineComparison=report.result.baselineComparison;
  report.pass = report.result.pass && report.pageErrors.length === 0;
  report.status=report.pass?(report.result.skippedChecks.length?'passed-with-skips':'passed'):'failed';
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  report.error = String(error.stack || error);
  if (/Cannot find package 'playwright'/.test(report.error)) report.dependencyHint = 'Install Playwright as a development dependency, or set GAME_AUDIO_PLAYWRIGHT to its absolute index.mjs path.';
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
}
