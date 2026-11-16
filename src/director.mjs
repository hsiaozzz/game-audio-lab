/** A deliberately local, bounded director for this research prototype.
 * Production replaces this routing step with a validated AI GameBrief adapter.
 */
export const EXAMPLE_PROMPTS = Object.freeze([
  { id: 'cozy', prompt: '做一个温暖的海岛钓鱼游戏，午后的阳光、轻柔的海浪，收获鱼儿时有愉快的奖励反馈。' },
  { id: 'neon', prompt: '做一个霓虹太空 3D 射击游戏，驾驶飞船穿越星门，躲避敌人并用能量武器战斗。' },
  { id: 'ruins', prompt: '做一个幽暗遗迹探索游戏，古老石门、神秘水晶和缓慢升起的迷雾，寻找失落的秘密。' }
]);

const PROFILES = {
  cozy: {
    title: 'Sunlit Tides', style: 'cozy', bpm: 92, rootMidi: 62, mode: 'major',
    instruments: ['marimba', 'softKeys', 'bass', 'kick', 'shaker', 'fmBell'],
    description: 'Warm mallet theme, soft keys, gently syncopated bass and brushed island percussion.',
    sceneStates: ['menu', 'exploration', 'fishing', 'reward'],
    eventBindings: { 'ui.confirm': 'ui', 'world.step': 'step', 'fishing.cast': 'cast', 'fishing.bite': 'alert', 'item.collect': 'collect', 'player.hit': 'hit', 'game.victory': 'victory', 'game.failure': 'failure' }
  },
  neon: {
    title: 'Prism Gate', style: 'neon', bpm: 116, rootMidi: 66, mode: 'minor',
    instruments: ['lead', 'pad', 'bass', 'kick', 'snare', 'hat'],
    description: 'Minor-key synth hook, suspended pad, pulsing bass, four-on-the-floor kick and evolving hats.',
    sceneStates: ['menu', 'exploration', 'combat', 'reward'],
    eventBindings: { 'ui.confirm': 'ui', 'world.step': 'step', 'weapon.fire': 'shoot', 'weapon.impact': 'hit', 'world.explosion': 'explosion', 'item.collect': 'collect', 'game.victory': 'victory', 'game.failure': 'failure' }
  },
  ruins: {
    title: 'Echoes Under Stone', style: 'ruins', bpm: 82, rootMidi: 57, mode: 'minor',
    instruments: ['fmBell', 'pad', 'bass', 'kick', 'shaker', 'pluck'],
    description: 'Sparse bell motif, suspended minor voicings, low pulse and delicate plucked echoes.',
    sceneStates: ['menu', 'exploration', 'danger', 'discovery'],
    eventBindings: { 'ui.confirm': 'ui', 'world.step': 'step', 'world.door': 'cast', 'world.danger': 'alert', 'item.collect': 'collect', 'player.hit': 'hit', 'game.victory': 'victory', 'game.failure': 'failure' }
  }
};

function hashString(text) {
  let hash = 2166136261;
  for (const codePoint of text) { hash ^= codePoint.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

export function directPrompt(prompt, { seed } = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new TypeError('A nonempty game prompt is required.');
  const cozy = /海岛|钓鱼|温暖|温馨|农场|休闲|island|fish|cozy|farm|warm/i.test(text);
  const neon = /霓虹|太空|射击|飞船|赛博|neon|space|shoot|cyber|spaceship/i.test(text);
  const ruins = /幽暗|遗迹|神秘|迷雾|地牢|ruins|mystery|dungeon|ancient|dark/i.test(text);
  const style = neon ? 'neon' : ruins ? 'ruins' : 'cozy';
  const profile = PROFILES[style];
  const normalizedSeed = seed === undefined ? hashString(text) : Number(seed) >>> 0;
  return {
    ...profile, id: `${style}-${normalizedSeed.toString(16).padStart(8, '0')}`,
    prompt: text, meter: 4, bars: 16, seed: normalizedSeed,
    sceneStates: [...profile.sceneStates], eventBindings: { ...profile.eventBindings },
    instruments: [...profile.instruments],
    director: {
      kind: 'local-rule-based-research-prototype',
      supportedProfiles: ['cozy', 'neon', 'ruins'],
      matched: cozy || neon || ruins,
      limitation: 'Keyword profile routing plus seeded composition; not an arbitrary-prompt AI music model.'
    }
  };
}
