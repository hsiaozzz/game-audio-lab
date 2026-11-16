import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const hash = file => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const names = ['audio-engine-validation', 'pipeline-validation', 'bridge-validation',
  'pipeline-browser-validation', 'release-ui-validation', 'server-validation'];
const technicalChecks = {};
for (const name of names) {
  const file = `artifacts/${name}.json`, result = read(file);
  assert.equal(result.pass, true, `${file} did not pass`);
  const sourceHashes = result.sourceHashes || (result.engineSha256 ? { 'src/audio-engine.mjs': result.engineSha256 } : {});
  for (const [source, expected] of Object.entries(sourceHashes)) {
    assert.equal(hash(source), expected, `${file} was recorded against a different ${source}`);
  }
  technicalChecks[name] = { pass: true, report: file, sha256: hash(file), verifiedSourceHashes: sourceHashes };
}
const report = {
  createdAt: new Date().toISOString(),
  sourceHashes: Object.fromEntries(['src/audio-engine.mjs', 'src/game-audio-pipeline.mjs',
    'src/game-audio-bridge.mjs', 'src/pipeline-demo.mjs', 'scripts/server.mjs',
    'scripts/blind-api.mjs', 'src/blind-ui.mjs', 'blind.html'].map(file => [file, hash(file)])),
  technicalChecks,
  historicalReports: ['render-suite', 'runtime-validation', 'engine-edge-validation', 'blind-ui-validation']
    .map(name => ({ report: `artifacts/${name}.json`, sha256: hash(`artifacts/${name}.json`),
      note: 'Preserved historical measurement; not a claim of rerunning against the final source.' })),
  listeningStatus: 'one-listener-eight-event-blind-test-complete',
  humanListeningAggregate: {
    listeners: 1, events: 8, scores: { procedural: 4.5, kenney: 3.5 },
    procedural: { wins: 3, losses: 2, ties: 3 },
    caveat: 'Anonymous small-sample preference only; not a statistical quality result or BGM evaluation. Raw human sessions are excluded from Git.'
  },
  notes: [
    'QA choices are automated and do not represent human preferences.',
    'The game pipeline demo uses a fixed game and a local rule director; no production integration or deployment is claimed.',
    'Browser tests are recorded observations. Run npm test for portable contract/server checks; audio rendering needs a browser.',
    'Historical render reports are not rewritten by this evidence index.'
  ],
  pass: true
};
fs.writeFileSync(path.join(root, 'artifacts/final-evidence.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ pass: report.pass, listeningStatus: report.listeningStatus,
  checks: Object.keys(technicalChecks) }, null, 2));
