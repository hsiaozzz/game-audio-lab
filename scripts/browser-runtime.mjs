import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Browser-test launcher. Production media generation also needs the pinned
// Playwright package and its Chromium; portable npm test does not launch it.
export const origin = process.env.GAME_AUDIO_ORIGIN || `http://127.0.0.1:${process.env.GAME_AUDIO_PORT || 4178}`;

export async function loadChromium() {
  try {
    const moduleName = process.env.GAME_AUDIO_PLAYWRIGHT;
    const { chromium } = await import(moduleName ? pathToFileURL(path.resolve(moduleName)).href : 'playwright');
    return chromium;
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('Install project dependencies with npm ci, then npx playwright install chromium. Portable npm test does not launch a browser.', { cause: error });
  }
}
