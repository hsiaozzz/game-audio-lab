# Research sound bank

This bank supports a controlled comparison between procedural synthesis and
recorded timbres in the independent GameAudioLab experiment. It contains 11
short sound effects and six marimba notes, not complete pre-recorded music.
The composer still creates the notes and arrangement. Technical checks do not
establish that the final music is enjoyable; that requires listening in context.

## Sound effects

The original files were read from the user's existing local `AudioX`
collection. No original file was modified. Official
Kenney asset pages explicitly identify each selected pack as CC0:

| Pack | Official source | Selected roles |
|---|---|---|
| Interface Sounds | https://kenney.nl/assets/interface-sounds | UI click, collection acknowledgement |
| Impact Sounds | https://kenney.nl/assets/impact-sounds | Wood/metal impact, grass and wood footsteps |
| RPG Audio | https://kenney.nl/assets/rpg-audio | Cast/swing transient, coin reward texture |
| Sci-Fi Sounds | https://kenney.nl/assets/sci-fi-sounds | Explosion, energy charge, laser |

The official pages were checked on 2026-11-16. The local folders did not include
their original license files or archives. `manifest.json` records both local
original hashes and prepared-file hashes; it does not claim an archive-to-file
comparison with a freshly downloaded official archive.

Prepared IDs are `ui`, `collect`, `hit`, `cast`, `footstep`, `footstepWood`,
`explosion`, `charge`, `laser`, `metal`, and `reward`. Some are intended as one
layer of a designed sound rather than the entire final effect. The manifest's
`gainDb` values are suggested runtime offsets, not automatic loudness matching.
For example, the laser and coin recording have lower peaks than other effects;
the final mix needs context-specific listening.

## Recorded marimba

Source: [VSCO 2 Community Edition](https://github.com/sgossner/VSCO-2-CE), pinned
to commit `440300901dfe9275fd84e0b7763af1f8443ae62e`.
The repository's [formal license](https://github.com/sgossner/VSCO-2-CE/blob/440300901dfe9275fd84e0b7763af1f8443ae62e/LICENSE)
is CC0 1.0 Universal. A copy is retained at
`assets/licenses/VSCO-CC0.txt`. Credit is retained here to Sam Gossner / Versilian
Studios and the VSCO contributors; the source README also expresses attribution
and direct sample resale preferences. This experiment uses the original source
samples, not an independently licensed third-party conversion.

**Pitch mapping was checked rather than inferred from the filenames.** The
source filenames label octaves one lower than the actual scientific sounding
pitch expected by Tone.Sampler. An initial filename-based map would therefore
have played music an octave too high. The manifest corrects this:

| Source filename note | Sampler key | Measured main frequency |
|---|---|---:|
| F3 | F4 | 348.91 Hz |
| C4 | C5 | 524.54 Hz |
| G4 | G5 | 782.93 Hz |
| B4 | B5 | 987.84 Hz |
| F5 | F6 | 1395.28 Hz |
| C6 | C7 | 2093.77 Hz |

The expected lower-octave frequencies in the latter five samples were about
51–73 dB below the observed sounding frequency, supporting an octave-label
correction rather than treating the peak as an unusually loud octave harmonic.
The final mapped pitches are all within 20 cents of equal temperament using
the FFT check in `assets/validation.json`.

Use `manifest.instruments.marimbaSampled.urls` directly as the sample map.
URL filenames retain source labels, while object keys contain corrected notes:

```js
{
  F4: '/assets/instruments/marimba/F3.wav',
  C5: '/assets/instruments/marimba/C4.wav',
  G5: '/assets/instruments/marimba/G4.wav',
  B5: '/assets/instruments/marimba/B4.wav',
  F6: '/assets/instruments/marimba/F5.wav',
  C7: '/assets/instruments/marimba/C6.wav'
}
```

The six notes are a small timbre demonstration, not a fully sampled marimba:
there is one dynamic layer, no round robin, and pitch shifting fills the gaps.
The F4 source provides the lower range for warm melody playing. The raw
outrigger recordings were very quiet; each prepared note is peak-normalized to
-4 dBFS before the common instrument gain is applied. This is level preparation,
not mastering, and does not equalize perceived loudness across notes.

## Preparation and validation

`scripts/prepare-assets.mjs` reproduces the bank with Node.js 20+ and installed
FFmpeg/FFprobe. It reads local Kenney files and downloads only the six
specified, pinned VSCO source samples plus its license. The local source root
must be provided with `--source <directory>` or `GAME_AUDIO_SOURCE`; there is no
machine-specific fallback. For example, run `npm run assets:prepare -- --source
<directory>` using a directory containing the four Kenney pack folders above.
Set `GAME_AUDIO_FFMPEG` and `GAME_AUDIO_FFPROBE` for binaries outside PATH.
Normal app use and `npm test` require neither FFmpeg nor these original files.

Processing is explicit: mono, 44.1 kHz, signed PCM16 WAV, conservative near-silent
edge trimming, 25 ms trailing padding. Marimba notes have a maximum three-second
prepared length with a short fade if the cap is reached. No musical notes are
created by the asset script.

All 17 prepared audio files together occupy **969,748 bytes** (about 0.925 MiB).
The cached original marimba inputs are an additional 5,124,444 bytes used only
for reproducible preparation; they are not required by the browser manifest.
The raw cache is excluded from Git. Prepared files and licenses are included.

`assets/validation.json` records: matching SHA-256 hashes, mono/44.1 kHz format,
nonzero RMS, no saturated PCM16 samples, and the marimba pitch checks. All 17
passed. This has not been described as a listening review.

Relevant licenses and source records:

- `assets/licenses/Kenney-CC0.md`
- `assets/licenses/VSCO-CC0.txt`
- `assets/manifest.json`
- CC0 legal text: https://creativecommons.org/publicdomain/zero/1.0/
