import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { handleBlindRequest } from './blind-api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportFile = path.join(root, 'artifacts/blind-api-validation.json');
const report = {
  createdAt: new Date().toISOString(),
  script: 'scripts/check-blind-api.mjs',
  purpose: 'Backend contract QA using a dedicated random local port and a session marked qa.',
  caveat: 'All choices are automated test inputs. The scores are test data, not human listening preferences or audio quality evidence.',
  checks: [], pass: false
};
const server = http.createServer(async (req, res) => {
  if (!await handleBlindRequest(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const request = async (route, method = 'GET', body) => {
  const response = await fetch(base + route, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const noSources = view => assert.equal(/procedural|kenney|sfx-|sha256/i.test(JSON.stringify(view)), false);
try {
  const created = await request('/api/blind/sessions', 'POST', { purpose: 'qa' });
  assert.equal(created.status, 201);
  let view = created.body;
  report.sessionId = view.id;
  assert.equal(view.purpose, 'qa'); assert.equal(view.total, 8); noSources(view);
  assert.deepEqual(view.round.listened, { A: false, B: false });
  const route = `/api/blind/sessions/${view.id}`;
  assert.equal((await request(route + '/results')).status, 409);
  assert.equal((await request(route + '/reveal')).status, 409);
  assert.equal((await request(route + '/votes', 'POST', { token: view.round.token, choice: 'A' })).status, 409);
  assert.equal((await request(route + '/votes', 'POST', { token: view.round.token, choice: 'invalid' })).status, 400);
  assert.equal((await request(route + '/votes', 'POST', { token: 'wrong-token', choice: 'A' })).status, 409);
  report.checks.push('qa marker', 'no source identities in initial response', 'early vote rejected', 'invalid choice rejected', 'wrong token rejected', 'early reveal rejected');
  const tooLarge = await fetch(base + '/api/blind/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(33000) }) });
  assert.equal(tooLarge.status, 413); await tooLarge.arrayBuffer();
  report.checks.push('32KB request limit');
  const audio = [];
  for (let index = 0; index < 8; index++) {
    assert.equal(view.round.index, index);
    for (const side of ['A', 'B']) {
      const response = await fetch(base + view.round.clips[side]), bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/wav');
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(Number(response.headers.get('content-length')), bytes.length);
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
      assert.equal(bytes.toString('ascii', 36, 40), 'data'); assert.equal(bytes.readUInt16LE(20), 1); assert.equal(bytes.readUInt16LE(34), 16);
      const sampleRate = bytes.readUInt32LE(24), channels = bytes.readUInt16LE(22), durationSeconds = (bytes.length - 44) / (sampleRate * channels * 2);
      assert.equal(durationSeconds, 1.8); audio.push({ index, side, bytes: bytes.length, sampleRate, channels, bitsPerSample: 16, durationSeconds });
    }
    const state = await request(route);
    assert.deepEqual(state.body.round.served, { A: true, B: true });
    assert.deepEqual(state.body.round.listened, { A: false, B: false });
    noSources(state.body);
    const token = view.round.token;
    if (index === 0) {
      const parallel = await Promise.all([request(route + '/votes', 'POST', { token, choice: 'A' }), request(route + '/votes', 'POST', { token, choice: 'B' })]);
      assert.deepEqual(parallel.map(result => result.status).sort(), [200, 409]);
      view = parallel.find(result => result.status === 200).body;
    } else {
      const choice = ['A', 'B', 'tie', 'neither'][index % 4];
      const voted = await request(route + '/votes', 'POST', { token, choice }); assert.equal(voted.status, 200); view = voted.body;
    }
    if (index < 7) noSources(view);
    assert.equal((await request(route + `/clips/${token}/A.wav`)).status, 409);
    assert.equal((await request(route + '/votes', 'POST', { token, choice: 'A' })).status, 409);
  }
  report.checks.push('16 valid stereo PCM16 WAV clips of 1.8 seconds', 'served is separate from listening', 'sources hidden through first seven votes', 'concurrent duplicate vote counted once', 'old audio token and duplicate votes rejected');
  assert.equal(view.completed, true); assert.equal(view.completedCount, 8); assert.equal(view.round, null);
  assert.equal(view.results.rounds.length, 8); assert.equal(new Set(view.results.rounds.map(round => round.event)).size, 8);
  assert.equal(view.results.maxScore, 8); assert.equal(view.results.scoreRule, '胜出1分，平局双方各0.5分，都不喜欢双方0分');
  assert.equal(view.results.matching.maxLoudnessSpreadLU, .1);
  assert.deepEqual(view.results.scores.map(score => score.ties), [2, 2]);
  assert.deepEqual(view.results.scores.map(score => score.neither), [2, 2]);
  assert.equal(view.results.scores.reduce((sum, score) => sum + score.wins, 0), 4);
  assert.equal(view.results.scores.reduce((sum, score) => sum + score.score, 0), 6);
  for (const round of view.results.rounds) assert.equal(round.winner, ['A', 'B'].includes(round.choice) ? round[round.choice] : round.choice);
  const sessionFile = `artifacts/blind-sessions/session-${view.id}.json`, evidence = JSON.parse(await fs.readFile(path.join(root, sessionFile), 'utf8'));
  assert.equal(evidence.completedCount, 8); assert.equal(evidence.purpose, 'qa');
  assert.equal(evidence.sourceAssets.procedural.sha256, view.results.sourceHashes.procedural);
  assert.equal(evidence.sourceAssets.kenney.sha256, view.results.sourceHashes.kenney);
  assert.equal((await request(route + '/results')).status, 200);
  assert.equal((await request('/api/blind/sessions/00000000-0000-0000-0000-000000000000')).status, 404);
  report.checks.push('eight unique revealed events', 'correct wins/ties/neither scoring', 'actual matching report and source hashes retained', 'atomic evidence saved with qa marker', 'unknown session returns 404');
  report.audio = audio; report.sessionEvidence = sessionFile;
  report.automatedTestScores = view.results.scores; report.matchingSpreadLU = view.results.matching.maxLoudnessSpreadLU;
  report.pass = true;
} catch (error) {
  report.error = String(error.stack || error); process.exitCode = 1;
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportFile, ...report }, null, 2));
}
