import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const sourceIndex = process.argv.indexOf('--source');
const sourceArgument = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : process.env.GAME_AUDIO_SOURCE;
if (!sourceArgument || sourceArgument.startsWith('--')) {
  throw new Error('Asset rebuilding requires your Kenney source folder: npm run assets:prepare -- --source <directory> (or GAME_AUDIO_SOURCE). Existing bundled assets need no rebuilding.');
}
const LOCAL_SOURCE = path.resolve(sourceArgument);
if (!fs.statSync(LOCAL_SOURCE, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Kenney source folder does not exist: ${LOCAL_SOURCE}`);
const FFMPEG = process.env.GAME_AUDIO_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.GAME_AUDIO_FFPROBE || (path.isAbsolute(FFMPEG) ? path.join(path.dirname(FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe');
const VSCO_COMMIT = '440300901dfe9275fd84e0b7763af1f8443ae62e';
const VSCO_ROOT = `https://raw.githubusercontent.com/sgossner/VSCO-2-CE/${VSCO_COMMIT}/`;
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const run = (exe, args) => {
  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  return result;
};
for (const folder of ['sfx', 'instruments/marimba', 'licenses', '.source/vsco']) fs.mkdirSync(path.join(ASSETS, folder), { recursive: true });

const selections = [
  { id: 'ui', pack: 'interface-sounds', name: 'click_001.ogg', gainDb: -10, role: 'short interface click' },
  { id: 'collect', pack: 'interface-sounds', name: 'confirmation_003.ogg', gainDb: -10, role: 'bright collection acknowledgement' },
  { id: 'hit', pack: 'impact-sounds', name: 'impactWood_medium_000.ogg', gainDb: -7, role: 'short material impact' },
  { id: 'cast', pack: 'rpg-audio', name: 'knifeSlice.ogg', gainDb: -9, role: 'cast or swing transient' },
  { id: 'footstep', pack: 'impact-sounds', name: 'footstep_grass_000.ogg', gainDb: -14, role: 'soft ground footstep' },
  { id: 'footstepWood', pack: 'impact-sounds', name: 'footstep_wood_000.ogg', gainDb: -14, role: 'wood ground footstep variant' },
  { id: 'explosion', pack: 'sci-fi-sounds', name: 'explosionCrunch_000.ogg', gainDb: -12, role: 'short explosion body' },
  { id: 'charge', pack: 'sci-fi-sounds', name: 'forceField_000.ogg', gainDb: -12, role: 'energy or shield charge' },
  { id: 'laser', pack: 'sci-fi-sounds', name: 'laserSmall_000.ogg', gainDb: -12, role: 'short science-fiction shot' },
  { id: 'metal', pack: 'impact-sounds', name: 'impactMetal_medium_000.ogg', gainDb: -10, role: 'metal impact or mechanism' },
  { id: 'reward', pack: 'rpg-audio', name: 'handleCoins2.ogg', gainDb: -11, role: 'coin texture for reward layering' }
];

function metadata(file) {
  const info = JSON.parse(run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels,codec_name', '-of', 'json', file]).stdout);
  const volume = run(FFMPEG, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']).stderr;
  return {
    durationSeconds: Number(Number(info.format.duration).toFixed(6)),
    sampleRate: Number(info.streams[0].sample_rate), channels: info.streams[0].channels,
    codec: info.streams[0].codec_name,
    peakDbFS: Number(volume.match(/max_volume: ([-\d.]+) dB/)?.[1]),
    meanDbFS: Number(volume.match(/mean_volume: ([-\d.]+) dB/)?.[1]),
    bytes: fs.statSync(file).size, sha256: hash(fs.readFileSync(file))
  };
}

const trim = 'silenceremove=start_periods=1:start_duration=0.001:start_threshold=-65dB,areverse,silenceremove=start_periods=1:start_duration=0.025:start_threshold=-65dB,areverse';
const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  description: 'Small research sound bank; sample selection and technical measurements are not a listening-quality certification.',
  samples: [], instruments: {},
  provenance: {
    kenney: { source: 'User-provided local AudioX folders, copied without changing originals.', verification: 'Official Kenney asset pages explicitly list CC0. Local original hashes are recorded; original download archives were unavailable for archive-to-file comparison.' },
    vsco: { repository: 'https://github.com/sgossner/VSCO-2-CE', commit: VSCO_COMMIT, license: 'CC0-1.0', licenseFile: '/assets/licenses/VSCO-CC0.txt' }
  }
};

for (const selection of selections) {
  const input = path.join(LOCAL_SOURCE, selection.pack, selection.name);
  if (!fs.existsSync(input)) throw new Error(`Missing local source: ${input}`);
  const output = path.join(ASSETS, 'sfx', `${selection.id}.wav`);
  run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-af', `${trim},apad=pad_dur=0.025`, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', output]);
  manifest.samples.push({ ...selection, url: `/assets/sfx/${selection.id}.wav`, source: `https://kenney.nl/assets/${selection.pack}`, sourceFile: selection.name, originalSha256: hash(fs.readFileSync(input)), license: 'CC0-1.0', ...metadata(output) });
}

const notes = ['F3', 'C4', 'G4', 'B4', 'F5', 'C6'];
const instrument = { id: 'marimbaSampled', label: 'VSCO 2 CE six-note marimba', type: 'multisample', license: 'CC0-1.0', gainDb: -8, urls: {}, samples: [], sourceCommit: VSCO_COMMIT, pitchConvention: 'Sampler keys use scientific pitch. The VSCO source filename octave is one lower than its measured sounding pitch; mapping corrected by +12 semitones.' };
for (const sourceNote of notes) {
  const note = sourceNote.replace(/\d+$/, octave => String(Number(octave) + 1));
  const originalName = `Marimba_hit_Outrigger_${sourceNote}_loud_01.wav`;
  const relative = `Percussion/Marimba/${originalName}`;
  const sourceUrl = VSCO_ROOT + relative.split('/').map(encodeURIComponent).join('/');
  const input = path.join(ASSETS, '.source/vsco', originalName);
  if (!fs.existsSync(input)) {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Download ${response.status}: ${sourceUrl}`);
    fs.writeFileSync(input, Buffer.from(await response.arrayBuffer()));
  }
  const output = path.join(ASSETS, 'instruments/marimba', `${sourceNote}.wav`);
  run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-af', `${trim},atrim=duration=3,afade=t=in:d=0.001,afade=t=out:st=2.82:d=0.18,apad=pad_dur=0.025`, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', output]);
  // Outrigger microphones are naturally quiet. Match sample peaks before the
  // runtime applies the common instrument gain; this is not loudness mastering.
  const normalizationDb = Number((-4 - metadata(output).peakDbFS).toFixed(2));
  const normalizedOutput = output.replace('.wav', '.normalizing.wav');
  run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', output, '-af', `volume=${normalizationDb}dB`, '-c:a', 'pcm_s16le', normalizedOutput]);
  fs.renameSync(normalizedOutput, output);
  const url = `/assets/instruments/marimba/${sourceNote}.wav`;
  instrument.urls[note] = url;
  instrument.samples.push({ note, sourceNote, url, source: sourceUrl, originalSha256: hash(fs.readFileSync(input)), normalizationDb, ...metadata(output) });
}
manifest.instruments.marimbaSampled = instrument;
const licenseResponse = await fetch(VSCO_ROOT + 'LICENSE', { signal: AbortSignal.timeout(20000) });
if (!licenseResponse.ok) throw new Error('VSCO license download failed');
fs.writeFileSync(path.join(ASSETS, 'licenses/VSCO-CC0.txt'), await licenseResponse.text());
fs.writeFileSync(path.join(ASSETS, 'licenses/Kenney-CC0.md'), '# Kenney sample provenance\n\nThese selected files derive from the user-provided local AudioX collection. Official source asset pages identify the packs as Creative Commons CC0:\n\n' + [...new Set(selections.map(s=>`- https://kenney.nl/assets/${s.pack}`))].join('\n') + '\n\nCC0 legal text: https://creativecommons.org/publicdomain/zero/1.0/\n\nKenney: https://kenney.nl/\nOriginal and prepared-file SHA-256 values are retained in manifest.json. This notice records official pack licensing; no original pack archive was available for archive-to-local-file comparison.\n');
fs.writeFileSync(path.join(ASSETS, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ samples: manifest.samples.length, marimbaNotes: Object.keys(instrument.urls), totalPreparedBytes: manifest.samples.reduce((sum,item)=>sum+item.bytes,0)+instrument.samples.reduce((sum,item)=>sum+item.bytes,0), manifest: path.join(ASSETS,'manifest.json') },null,2));
