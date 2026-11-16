/** Structured, seeded phrase composition. No audio APIs and no dependencies. */
const MODES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const rounded = x => Math.round(x * 10000) / 10000;
function generator(seed) {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let x = state; x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61); return ((x ^ x >>> 14) >>> 0) / 4294967296; };
}
function degreeMidi(root, degree, mode) {
  const octave = Math.floor(degree / 7), index = ((degree % 7) + 7) % 7;
  return root + octave * 12 + mode[index];
}
function nearestChordDegree(desired, chord) {
  const candidates = [];
  for (let octave = -2; octave <= 2; octave++) for (const tone of [0, 2, 4]) candidates.push(chord + tone + 7 * octave);
  return candidates.reduce((best, value) => Math.abs(value - desired) < Math.abs(best - desired) ? value : best, candidates[0]);
}
function voiceChord(root, chordDegree, mode, previous) {
  let best, cost = Infinity;
  const rootVoicing = [chordDegree, chordDegree + 2, chordDegree + 4];
  for (let inversion = 0; inversion < 3; inversion++) {
    const degrees = rootVoicing.map((degree, i) => degree + (i < inversion ? 7 : 0)).sort((a, b) => a - b);
    for (let shift = -2; shift <= 0; shift++) {
      const notes = degrees.map(degree => degreeMidi(root, degree + shift * 7, mode));
      if (notes[0] < root - 17 || notes[2] > root + 4) continue;
      const value = previous ? notes.reduce((sum, note, i) => sum + Math.abs(note - previous[i]), 0) : Math.abs(notes[1] - (root - 5));
      if (value < cost) { cost = value; best = notes; }
    }
  }
  return best || rootVoicing.map(degree => degreeMidi(root - 12, degree, mode));
}

const PROGRESSIONS = {
  cozy: [0, 4, 5, 3, 0, 4, 1, 4, 5, 3, 0, 4, 3, 4, 0, 0],
  neon: [0, 5, 2, 6, 0, 5, 3, 6, 5, 3, 0, 4, 5, 6, 0, 4],
  ruins: [0, 5, 3, 0, 6, 5, 3, 4, 5, 6, 0, 4, 3, 4, 0, 0]
};
const THEMES = {
  cozy: [
    [[0, 2, 4, 5, 4, 2], [1, 2, 4, 6, 5, 4], [4, 5, 7, 6, 4, 2], [3, 2, 1, 2, 0, 0]],
    [[2, 4, 5, 7, 5, 4], [1, 2, 4, 2, 1, 0], [4, 7, 6, 5, 4, 2], [3, 4, 2, 1, 0, 0]]
  ],
  neon: [
    [[0, 0, 4, 3, 2, 4, 0, 2], [0, 2, 4, 6, 4, 2, 1, 0], [2, 2, 6, 5, 4, 6, 2, 4], [3, 2, 1, 4, 2, 1, 0, 0]],
    [[0, 4, 0, 2, 3, 2, 4, 0], [2, 4, 6, 4, 2, 0, 1, 0], [4, 6, 4, 2, 6, 5, 4, 2], [3, 4, 2, 1, 2, 1, 0, 0]]
  ],
  ruins: [
    [[0, 4, 2], [1, 5, 4], [2, 6, 4], [3, 2, 0]],
    [[0, 2, 4], [1, 4, 2], [2, 5, 6], [3, 1, 0]]
  ]
};

export function composeScore(brief) {
  if (!brief || !MODES[brief.mode] || !PROGRESSIONS[brief.style]) throw new TypeError('Unsupported or missing validated GameBrief.');
  if (brief.bars !== 16 || brief.meter !== 4 || !(brief.bpm > 0)) throw new RangeError('This composition profile uses 16 bars in 4/4.');
  const { style, bpm, rootMidi: root, bars, meter } = brief, mode = MODES[brief.mode];
  const random = generator(brief.seed), totalBeats = bars * meter;
  const variation = Math.floor(random() * THEMES[style].length), theme = THEMES[style][variation];
  const progression = [...PROGRESSIONS[style]];
  // A second approved harmonic path changes colour while preserving cadences.
  if (random() > .5) { progression[2] = style === 'cozy' ? 1 : 3; progression[10] = style === 'cozy' ? 5 : 2; }
  const track = (id, role, instrument, pan, gainDb) => ({ id, role, instrument, pan, gainDb, events: [] });
  const lead = track('theme', 'lead', style === 'cozy' ? 'marimba' : style === 'neon' ? 'lead' : 'fmBell', -.12, style === 'neon' ? -14 : -10);
  const harmony = track('harmony', style === 'cozy' ? 'harmony' : 'pad', style === 'cozy' ? 'softKeys' : 'pad', .12, style === 'cozy' ? -18 : -20);
  const bass = track('bass', 'bass', 'bass', 0, -13);
  const kick = track('kick', 'drums', 'kick', 0, style === 'neon' ? -11 : -17);
  const rhythm = track(style === 'neon' ? 'snare' : 'shaker', 'drums', style === 'neon' ? 'snare' : 'shaker', .15, style === 'neon' ? -19 : -23);
  const accent = track(style === 'neon' ? 'hat' : 'ornament', style === 'neon' ? 'drums' : 'ornament', style === 'neon' ? 'hat' : style === 'cozy' ? 'fmBell' : 'pluck', style === 'neon' ? -.2 : .28, style === 'neon' ? -25 : -19);
  const tracks = [lead, harmony, bass, kick, rhythm, accent];
  const add = (target, beat, midi, length, velocity, human = true) => {
    const micro = human ? (random() - .5) * (style === 'neon' ? .009 : .018) : 0;
    const at = clamp(beat + micro, 0, totalBeats - .04), duration = Math.min(length, totalBeats - at - .015);
    if (duration <= 0) return;
    target.events.push({ beat: rounded(at), midi, durationBeats: rounded(duration), velocity: rounded(clamp(velocity + (human ? (random() - .5) * .07 : 0), .05, 1)) });
  };
  let previousVoicing;
  for (let bar = 0; bar < bars; bar++) {
    const chord = progression[bar], base = bar * 4, sectionB = bar >= 8 && bar < 12, reprise = bar >= 12;
    const voicing = voiceChord(root, chord, mode, previousVoicing); previousVoicing = voicing;
    if (style === 'cozy') {
      for (const offset of [0, 1.5, 3]) for (let i = 0; i < voicing.length; i++) add(harmony, base + offset + i * .025, voicing[i], offset === 3 ? .75 : 1.1, .44 - i * .035);
    } else {
      voicing.forEach((midi, index) => add(harmony, base + index * .015, midi, 3.85, sectionB ? .38 : .3));
      if (sectionB) add(harmony, base, degreeMidi(root, chord + 6, mode), 3.8, .19);
    }

    // Phrase material repeats with coherent answer endings and a contrasting B.
    const degrees = [...theme[bar % 4]];
    if (sectionB) for (let i = 0; i < degrees.length; i++) degrees[i] += i < degrees.length / 2 ? 2 : 0;
    if (reprise && bar % 4 === 0) degrees[degrees.length - 2] += 2;
    if (bar === 15) { degrees[degrees.length - 1] = 0; degrees[degrees.length - 2] = 2; }
    const offsets = style === 'cozy' ? [0, .75, 1.5, 2, 2.75, 3.5] : style === 'neon' ? [0, .5, 1, 1.5, 2, 2.5, 3, 3.5] : [0, 1.5, 3];
    const melodyOctave = style === 'ruins' ? 12 : 0;
    degrees.forEach((desired, i) => {
      const strong = offsets[i] % 2 === 0;
      let degree = strong ? nearestChordDegree(desired, chord) : desired;
      degree = clamp(degree, -1, 10);
      if (bar === 15 && i === degrees.length - 1) degree = 0;
      // Rest every second answer tail; a recognisable motif needs breathing room.
      if ((bar % 4 === 1 || bar % 4 === 3) && i === degrees.length - 2 && style !== 'neon') return;
      const endOfPhrase = i === degrees.length - 1 && bar % 4 === 3;
      const duration = style === 'ruins' ? 1.15 : style === 'neon' ? .29 : endOfPhrase ? .38 : .43;
      add(lead, base + offsets[i], degreeMidi(root + melodyOctave, degree, mode), duration, style === 'neon' ? .56 + (strong ? .12 : 0) : .62 + (strong ? .08 : 0));
    });

    const bassRoot = degreeMidi(root - 24, chord, mode), bassFifth = degreeMidi(root - 24, chord + 4, mode);
    if (style === 'cozy') {
      add(bass, base, bassRoot, .85, .62); add(bass, base + 1.5, bassFifth, .36, .4);
      add(bass, base + 2.5, bassRoot + 12, .5, .45);
      if (bar % 4 === 3) add(bass, base + 3.5, degreeMidi(root - 24, progression[(bar + 1) % bars] - 1, mode), .35, .36);
    } else if (style === 'neon') {
      for (let step = 0; step < 8; step++) add(bass, base + step * .5, step === 5 ? bassFifth : step === 7 && sectionB ? bassRoot + 12 : bassRoot, .32, step % 2 ? .4 : .64);
    } else { add(bass, base, bassRoot, 1.7, .49); if (bar % 2) add(bass, base + 2.5, bassFifth, 1.1, .31); }

    if (style === 'neon') {
      for (let beat = 0; beat < 4; beat++) add(kick, base + beat, 36, .3, beat === 0 ? .91 : .78, false);
      for (const beat of [1, 3]) add(rhythm, base + beat, 38, .3, .72);
      for (let step = 0; step < 8; step++) add(accent, base + step * .5, 42, .09, step % 2 ? .37 : .2);
      if (bar % 4 === 3) for (const [offset, velocity] of [[3.25, .32], [3.5, .42], [3.75, .55]]) add(rhythm, base + offset, 38, .14, velocity);
    } else if (style === 'cozy') {
      add(kick, base, 36, .24, .54); add(kick, base + 2.5, 36, .24, .38);
      for (let step = 0; step < 8; step++) add(rhythm, base + step * .5 + (step % 2 ? .035 : 0), 42, .08, step % 2 ? .27 : .18);
      if (bar % 2 === 1) for (const [offset, degree] of [[2.75, chord + 4], [3.5, chord + 2]]) add(accent, base + offset, degreeMidi(root + 12, degree, mode), .28, .27);
    } else {
      if (bar % 2 === 0) add(kick, base, 36, .35, .4);
      for (const offset of [1.5, 3.5]) add(rhythm, base + offset, 42, .12, .16);
      if (bar % 2 === 1) for (const [offset, degree] of [[.75, chord + 4], [2.75, chord + 2]]) add(accent, base + offset, degreeMidi(root + 12, degree, mode), .65, .31);
    }
  }
  for (const item of tracks) item.events.sort((a, b) => a.beat - b.beat || a.midi - b.midi);
  const cue = (degrees, durations) => degrees.map((degree, i) => ({ beat: i * .5, midi: degreeMidi(root + (style === 'ruins' ? 12 : 0), degree, mode), durationBeats: durations[i], velocity: .68 }));
  return {
    schemaVersion: 1, brief, bpm, meter, bars,
    duration: totalBeats * 60 / bpm,
    sections: [{ name: 'A', startBar: 0, bars: 8 }, { name: 'B', startBar: 8, bars: 4 }, { name: "A′", startBar: 12, bars: 4 }],
    tracks,
    cues: { victory: cue([0, 2, 4, 7], [.35, .35, .35, 1.2]), failure: cue([4, 2, 0, -7], [.4, .4, .5, 1.4]) },
    statistics: { eventCount: tracks.reduce((sum, item) => sum + item.events.length, 0), trackCount: tracks.length, uniqueChords: new Set(progression).size, progression, themeVariant: variation, seed: brief.seed, engine: 'seeded-phrase-composer-v1' }
  };
}
