import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional execution harness only. Normal app use and npm test need no browser package.
export const origin = process.env.GAME_AUDIO_ORIGIN || `http://127.0.0.1:${process.env.GAME_AUDIO_PORT || 4178}`;

export async function loadChromium() {
  try {
    const moduleName = process.env.GAME_AUDIO_PLAYWRIGHT;
    const { chromium } = await import(moduleName ? pathToFileURL(path.resolve(moduleName)).href : 'playwright');
    return chromium;
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('Optional browser harness requires npm install, then npx playwright install chromium. Normal npm start and npm test do not need Playwright.', { cause: error });
  }
}
