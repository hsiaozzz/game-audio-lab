import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(root, 'artifacts');
const sessionRoot = path.join(artifactRoot, 'blind-sessions');
const TOTAL = 8, CLIP_SECONDS = 1.8, BODY_LIMIT = 32 * 1024;
const EVENT_IDS = ['ui', 'collect', 'cast', 'footstep', 'hit', 'laser', 'charge', 'explosion'];
const SOURCES = ['procedural', 'kenney'];
const LABELS = { procedural: '程序合成', kenney: 'Kenney参考' };
const CHOICES = new Set(['A', 'B', 'tie', 'neither']);
const SCORE_RULE = '胜出1分，平局双方各0.5分，都不喜欢双方0分';
const sessions = new Map();
const restoringSessions = new Map();
let bankPromise;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
  res.end(bytes);
}

function readJson(req) {
  if (Number(req.headers['content-length']) > BODY_LIMIT) {
    req.resume();
    return Promise.reject(new HttpError(413, 'Request exceeds 32 KB.'));
  }
  return new Promise((resolve, reject) => {
    let size = 0, oversized = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        if (!oversized) { oversized = true; chunks.length = 0; reject(new HttpError(413, 'Request exceeds 32 KB.')); }
      } else if (!oversized) chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) return;
      try {
        const body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(new HttpError(400, 'Expected a JSON object.')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new HttpError(400, 'Request aborted.')));
  });
}

function readPcm16(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid source WAV.');
  let format, channels, sampleRate, bits, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > bytes.length) throw new Error('Truncated source WAV.');
    if (tag === 'fmt ') {
      if (length < 16) throw new Error('Invalid WAV format.');
      format = bytes.readUInt16LE(start); channels = bytes.readUInt16LE(start + 2);
      sampleRate = bytes.readUInt32LE(start + 4); bits = bytes.readUInt16LE(start + 14);
    } else if (tag === 'data') data = bytes.subarray(start, start + length);
    offset = start + length + (length % 2);
  }
  if (format !== 1 || bits !== 16 || !channels || !sampleRate || !data || data.length % (channels * 2)) throw new Error('Expected PCM16 source WAV.');
  return { channels, sampleRate, data, frames: data.length / (channels * 2) };
}

function pcmClip(wav, startSeconds) {
  const first = Math.round(startSeconds * wav.sampleRate), frames = Math.round(CLIP_SECONDS * wav.sampleRate), block = wav.channels * 2;
  if (first + frames > wav.frames) throw new Error('Source WAV is shorter than an event slot.');
  const data = wav.data.subarray(first * block, (first + frames) * block), out = Buffer.alloc(44 + data.length);
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(wav.channels, 22); out.writeUInt32LE(wav.sampleRate, 24);
  out.writeUInt32LE(wav.sampleRate * block, 28); out.writeUInt16LE(block, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(data.length, 40); data.copy(out, 44);
  return out;
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function loadBank() {
  if (!bankPromise) bankPromise = (async () => {
    const reportBytes = await fs.readFile(path.join(artifactRoot, 'sfx-comparison.json'));
    const report = JSON.parse(reportBytes.toString('utf8'));
    if (report.pass !== true || report.spacingSeconds !== CLIP_SECONDS || report.events?.length !== TOTAL || report.events.some((event, index) => event.id !== EVENT_IDS[index] || Math.abs(event.start - index * CLIP_SECONDS) > 1e-6)) throw new Error('Matched comparison report is not valid for these event slots.');
    const clips = {}, sourceAssets = {};
    for (const [id, variant] of [['procedural', 'synth'], ['kenney', 'reference']]) {
      const filename = `sfx-${variant}-matched.wav`, bytes = await fs.readFile(path.join(artifactRoot, filename));
      const digest = sha256(bytes), wav = readPcm16(bytes);
      if (digest !== report.outputs?.[variant]?.sha256) throw new Error('Matched WAV hash differs from its comparison report.');
      clips[id] = EVENT_IDS.map((_, index) => pcmClip(wav, index * CLIP_SECONDS));
      sourceAssets[id] = { filename, sha256: digest, sampleRate: wav.sampleRate, channels: wav.channels, bitsPerSample: 16, clipHashes: clips[id].map(sha256) };
    }
    const matching = {
      method: report.method,
      matchingPasses: report.matchingPasses,
      maxLoudnessSpreadLU: Number(report.maxLoudnessSpreadLU.toFixed(3)),
      clipSeconds: CLIP_SECONDS,
      onsetSeconds: report.onsetSeconds,
      sourceReportSha256: sha256(reportBytes),
      events: report.events.map(event => ({
        event: event.id, targetLUFS: event.targetLUFS,
        procedural: { gainDb: event.variants.synth.gainDb, ...event.variants.synth.matched },
        kenney: { gainDb: event.variants.reference.gainDb, ...event.variants.reference.matched }
      }))
    };
    return { clips, sourceAssets, matching };
  })().catch(error => { bankPromise = undefined; throw error; });
  return bankPromise;
}

function shuffledEvents() {
  const order = Array.from({ length: TOTAL }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index--) { const other = randomInt(index + 1); [order[index], order[other]] = [order[other], order[index]]; }
  return order;
}

function publicRound(session) {
  const round = session.rounds[session.cursor];
  if (!round) return null;
  const base = `/api/blind/sessions/${session.id}/clips/${round.token}`;
  return { index: session.cursor, token: round.token, clips: { A: `${base}/A.wav`, B: `${base}/B.wav` }, listened: { A: false, B: false }, served: { ...round.served } };
}

function finalResults(session, bank) {
  const scores = SOURCES.map(id => ({ id, label: LABELS[id], wins: 0, ties: 0, neither: 0, score: 0 }));
  const rounds = session.rounds.map((round, index) => {
    const winner = round.choice === 'A' || round.choice === 'B' ? round[round.choice] : round.choice;
    for (const score of scores) {
      if (winner === score.id) { score.wins++; score.score++; }
      else if (winner === 'tie') { score.ties++; score.score += .5; }
      else if (winner === 'neither') score.neither++;
    }
    return { index, event: EVENT_IDS[round.eventIndex], choice: round.choice, A: round.A, B: round.B, winner };
  });
  return {
    scores, rounds, total: TOTAL, maxScore: TOTAL, scoreRule: SCORE_RULE,
    winner: scores[0].score === scores[1].score ? 'tie' : scores[0].score > scores[1].score ? scores[0].id : scores[1].id,
    matching: bank.matching,
    sourceHashes: Object.fromEntries(SOURCES.map(id => [id, bank.sourceAssets[id].sha256])),
    scope: 'This session only; served audio does not prove listening. No global score is maintained.'
  };
}

function publicSession(session, bank) {
  const completed = session.cursor === TOTAL;
  const view = { id: session.id, purpose: session.purpose, total: TOTAL, completedCount: session.cursor, completed, round: publicRound(session), votes: session.rounds.slice(0, session.cursor).map((round, index) => ({ index, choice: round.choice })) };
  if (completed) view.results = finalResults(session, bank);
  return view;
}

async function persist(session, bank) {
  await fs.mkdir(sessionRoot, { recursive: true });
  const destination = path.join(sessionRoot, `session-${session.id}.json`), temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
  const evidence = {
    schemaVersion: 1, id: session.id, purpose: session.purpose, createdAt: session.createdAt, updatedAt: session.updatedAt,
    completedAt: session.completedAt, total: TOTAL, completedCount: session.cursor, scoreRule: SCORE_RULE,
    randomization: 'Fisher-Yates event order and independent A/B allocation using node:crypto.randomInt; opaque random round tokens.',
    listeningEvidence: 'served records only a completed HTTP response; actual listening is enforced by the client UI and is not claimed by this file.',
    sourceAssets: bank.sourceAssets, matching: bank.matching,
    rounds: session.rounds.map((round, index) => ({ index, event: EVENT_IDS[round.eventIndex], ...round })),
    ...(session.cursor === TOTAL ? { results: finalResults(session, bank) } : {})
  };
  try { await fs.writeFile(temporary, JSON.stringify(evidence, null, 2), { flag: 'wx' }); await fs.rename(temporary, destination); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}

async function locked(session, operation) {
  const previous = session.pending;
  let release;
  session.pending = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await operation(); } finally { release(); }
}

async function restoreSession(id, bank) {
  if (sessions.has(id)) return sessions.get(id);
  if (!restoringSessions.has(id)) {
    const pending = (async () => {
      let saved;
      try { saved = JSON.parse(await fs.readFile(path.join(sessionRoot, `session-${id}.json`), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') throw new HttpError(404, 'Session not found.'); throw error; }
      const cursor = saved.completedCount;
      if (saved.schemaVersion !== 1 || saved.id !== id || !['qa', 'listener'].includes(saved.purpose) ||
          !Number.isInteger(cursor) || cursor < 0 || cursor > TOTAL || saved.rounds?.length !== TOTAL ||
          new Set(saved.rounds.map(round => round.eventIndex)).size !== TOTAL) throw new Error('Invalid saved blind session.');
      const rounds = saved.rounds.map((round, index) => {
        if (!Number.isInteger(round.eventIndex) || round.eventIndex < 0 || round.eventIndex >= TOTAL ||
            !/^[a-f0-9]{48}$/.test(round.token) || !SOURCES.includes(round.A) || !SOURCES.includes(round.B) || round.A === round.B ||
            (index < cursor ? !CHOICES.has(round.choice) : round.choice !== null)) throw new Error('Invalid saved round.');
        return { eventIndex: round.eventIndex, token: round.token, A: round.A, B: round.B,
          served: { A: !!round.served?.A, B: !!round.served?.B }, choice: round.choice, votedAt: round.votedAt };
      });
      if (SOURCES.some(source => saved.sourceAssets?.[source]?.sha256 !== bank.sourceAssets[source].sha256))
        throw new HttpError(409, 'The sound comparison has changed. Start a new session.');
      const session = { id, purpose: saved.purpose, createdAt: saved.createdAt, updatedAt: saved.updatedAt,
        completedAt: saved.completedAt, cursor, rounds, pending: Promise.resolve() };
      sessions.set(id, session);
      return session;
    })();
    restoringSessions.set(id, pending);
  }
  try { return await restoringSessions.get(id); }
  finally { restoringSessions.delete(id); }
}

/** Returns true for /api/blind/*, including its errors. Other paths are untouched. */
export async function handleBlindRequest(req, res, url) {
  if (url.pathname !== '/api/blind' && !url.pathname.startsWith('/api/blind/')) return false;
  try {
    const collection = url.pathname === '/api/blind/sessions';
    const match = url.pathname.match(/^\/api\/blind\/sessions\/([a-f0-9-]{36})(?:\/(votes|results|reveal)|\/clips\/([a-f0-9]{48})\/([AB])\.wav)?$/);
    if (!collection && !match) throw new HttpError(404, 'Blind endpoint not found.');
    if (collection) {
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST to create a session.');
      const body = await readJson(req);
      if (body.purpose !== undefined && !['qa', 'listener'].includes(body.purpose)) throw new HttpError(400, 'Invalid session purpose.');
      const bank = await loadBank(), now = new Date().toISOString();
      const session = { id: randomUUID(), purpose: body.purpose || 'listener', createdAt: now, updatedAt: now, completedAt: null, cursor: 0, pending: Promise.resolve(), rounds: shuffledEvents().map(eventIndex => {
        const order = randomInt(2) ? SOURCES : [...SOURCES].reverse();
        return { eventIndex, token: randomBytes(24).toString('hex'), A: order[0], B: order[1], served: { A: false, B: false }, choice: null, votedAt: null };
      }) };
      await persist(session, bank); sessions.set(session.id, session);
      json(res, 201, publicSession(session, bank)); return true;
    }
    const [, id, action, token, side] = match;
    const bank = await loadBank();
    const session = await restoreSession(id, bank);
    if (token) {
      if (req.method !== 'GET') throw new HttpError(405, 'Use GET for audio.');
      const round = session.rounds[session.cursor];
      if (!round || round.token !== token) throw new HttpError(409, 'Only the current round audio is available.');
      const bytes = bank.clips[round[side]][round.eventIndex];
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.once('finish', () => { round.served[side] = true; });
      res.end(bytes); return true;
    }
    if (action === 'votes') {
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST to submit a vote.');
      const body = await readJson(req);
      if (!CHOICES.has(body.choice) || typeof body.token !== 'string') throw new HttpError(400, 'Invalid vote choice or token.');
      await locked(session, async () => {
        const round = session.rounds[session.cursor];
        if (!round || round.token !== body.token) throw new HttpError(409, 'Vote is not for the current round.');
        if (!round.served.A || !round.served.B) throw new HttpError(409, 'Both clips must be requested before voting.');
        const now = new Date().toISOString(), next = { ...session, cursor: session.cursor + 1, updatedAt: now, completedAt: session.cursor + 1 === TOTAL ? now : null, rounds: session.rounds.map((entry, index) => index === session.cursor ? { ...entry, served: { ...entry.served }, choice: body.choice, votedAt: now } : entry) };
        await persist(next, bank);
        session.rounds = next.rounds; session.cursor = next.cursor; session.updatedAt = now; session.completedAt = next.completedAt;
      });
      json(res, 200, publicSession(session, bank)); return true;
    }
    if (action === 'results' || action === 'reveal') {
      if (req.method !== 'GET') throw new HttpError(405, 'Use GET for results.');
      if (session.cursor !== TOTAL) throw new HttpError(409, 'Results are revealed only after all eight votes.');
      json(res, 200, publicSession(session, bank)); return true;
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Use GET for session progress.');
    json(res, 200, publicSession(session, bank));
  } catch (error) {
    if (!(error instanceof HttpError)) console.error('[blind-api]', error);
    if (!res.headersSent) json(res, error.status || 503, { error: error instanceof HttpError ? error.message : 'Blind audio is temporarily unavailable.' });
    else res.end();
  }
  return true;
}
