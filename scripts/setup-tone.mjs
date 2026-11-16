import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'vendor');
const version = '15.1.22';
const source = `https://registry.npmjs.org/tone/-/tone-${version}.tgz`;
const expectedIntegrity = 'sha512-TCScAGD4sLsama5DjvTUXlLDXSqPealhL64nsdV1hhr6frPWve0DeSo63AKnSJwgfg55fhvxj0iPPRwPN5o0ag==';
const expectedBundleSha256 = 'e290952fa43d9a7a780182a83c6fccf44d79cb7ae2cba102ef1f2b9d98124e22';
const response = await fetch(source, { signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`Tone download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
if (integrity !== expectedIntegrity) throw new Error('Tone package differs from the pinned npm integrity');
await fs.mkdir(dir, { recursive: true });
const archive = path.join(dir, `tone-${version}.tgz`);
await fs.writeFile(archive, bytes);
const temporaryRoot = path.resolve(os.tmpdir());
const unpack = await fs.mkdtemp(path.join(temporaryRoot, `game-audio-tone-${version}-`));
try {
  execFileSync('tar', ['-xf', archive, '-C', unpack], { windowsHide: true });
  const bundle = await fs.readFile(path.join(unpack, 'package/build/Tone.js'));
  const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
  if (bundleSha256 !== expectedBundleSha256) throw new Error('Tone bundle differs from the pinned bundle hash');
  const license = await fs.readFile(path.join(unpack, 'package/LICENSE.md'));
  const bundleNotice = await fs.readFile(path.join(unpack, 'package/build/Tone.js.LICENSE.txt'));
  await fs.writeFile(path.join(dir, 'Tone.js'), bundle);
  await fs.writeFile(path.join(dir, 'Tone.LICENSE.md'), license);
  await fs.writeFile(path.join(dir, 'Tone.js.LICENSE.txt'), bundleNotice);
  await fs.writeFile(path.join(dir, 'provenance.json'), JSON.stringify({ name: 'tone', version, license: 'MIT', source, integrity, bytes: bytes.length, bundleSha256 }, null, 2) + '\n');
  console.log(JSON.stringify({ version, bundleBytes: bundle.length, integrityVerified: true, bundleHashVerified: true }));
} finally {
  // Only remove the directory created above, after verifying its absolute parent.
  if (path.dirname(path.resolve(unpack)) !== temporaryRoot || !path.basename(unpack).startsWith(`game-audio-tone-${version}-`)) throw new Error('Unexpected temporary extraction path');
  await fs.rm(unpack, { recursive: true, force: true });
}
