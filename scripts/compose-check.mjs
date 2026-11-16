import assert from 'node:assert/strict';
import { EXAMPLE_PROMPTS, directPrompt } from '../src/director.mjs';
import { composeScore } from '../src/composer.mjs';

const scales = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const pitchedRoles = new Set(['lead', 'harmony', 'pad', 'bass', 'ornament']);
const summaries = [];
for (const example of EXAMPLE_PROMPTS) {
  const brief = directPrompt(example.prompt, { seed: 1701 });
  assert.equal(brief.style, example.id);
  assert.equal(brief.director.kind, 'local-rule-based-research-prototype');
  const score = composeScore(brief), again = composeScore(directPrompt(example.prompt, { seed: 1701 }));
  assert.deepEqual(score, again, 'Seed must reproduce the same composition.');
  assert.notDeepEqual(score.tracks, composeScore(directPrompt(example.prompt, { seed: 2002 })).tracks, 'A new seed must alter the arrangement.');
  assert.equal(score.duration, 64 * 60 / brief.bpm);
  assert.equal(score.tracks.length, 6);
  assert(score.statistics.eventCount > 100 && score.statistics.eventCount < 1500);
  assert(score.statistics.uniqueChords >= 4);
  assert.deepEqual(score.sections.map(x => x.bars), [8, 4, 4]);
  for (const track of score.tracks) {
    assert(track.events.length > 0);
    let previous = -1;
    for (const event of track.events) {
      assert(event.beat >= 0 && event.beat >= previous); previous = event.beat;
      assert(event.durationBeats > 0 && event.beat + event.durationBeats <= 64 + .0001);
      assert(event.velocity > 0 && event.velocity <= 1);
      assert(Number.isInteger(event.midi) && event.midi >= 24 && event.midi <= 100);
      if (pitchedRoles.has(track.role)) assert(scales[brief.mode].includes(((event.midi - brief.rootMidi) % 12 + 12) % 12), `Out-of-mode note ${event.midi} in ${track.id}`);
    }
  }
  summaries.push({ style: brief.style, bpm: brief.bpm, seconds: score.duration, events: score.statistics.eventCount, tracks: score.tracks.map(track => `${track.id}:${track.instrument}`), progression: score.statistics.progression });
}
assert.throws(() => directPrompt(''), /nonempty/);
assert.throws(() => composeScore({}), /Unsupported/);
assert.equal(directPrompt('an abstract platform game').director.matched, false);
assert.equal(directPrompt('Neon space shooter').style, 'neon');
assert.equal(directPrompt('cozy island fishing').style, 'cozy');
assert.equal(directPrompt('ancient dark ruins').style, 'ruins');
assert.equal(new Set(summaries.map(item => JSON.stringify(item.progression))).size, 3);
console.log(JSON.stringify({ pass: true, summaries }, null, 2));
