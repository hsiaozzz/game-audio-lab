// Replace these functions in your own trusted module; no URLs or executable code come from players.
import { directPrompt as localDirection } from '../src/director.mjs';
import { composeScore as localComposition } from '../src/composer.mjs';

export const version = 'example-algorithm-module-v1';
export const modelConnected = false;

export async function directPrompt(prompt, { seed } = {}) {
  // An algorithm can call its own model here. Preserve the seed and supported instrument palette.
  return localDirection(prompt, seed === undefined ? {} : { seed });
}

export async function composeScore(audioBrief, { gameBrief, eventContract }) {
  // Return bounded score JSON, never oscillator code or arbitrary asset URLs.
  return localComposition(audioBrief);
}
