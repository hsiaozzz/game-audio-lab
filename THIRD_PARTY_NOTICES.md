# Third-party notices

These notices describe bundled dependencies and source samples. They do not
grant a license to the project's original code. No project-wide open-source
license has been selected.

## Tone.js 15.1.22

- Source: <https://github.com/Tonejs/Tone.js> and the pinned npm distribution.
- License: MIT, copyright Yotam Mann and contributors.
- Retained license: `vendor/Tone.LICENSE.md`.
- Retained bundle notice: `vendor/Tone.js.LICENSE.txt`.
- Integrity and bundle SHA-256: `vendor/provenance.json`.

The vendored distribution includes the notices supplied by its publisher.
The backend renderer uses Playwright 1.63.0 (Apache-2.0), installed through npm,
and its separately installed Chromium runtime. Their licenses and browser
notices accompany those installations. They are not part of exported game
playback packages. FFmpeg/ffprobe are operator-installed system dependencies;
their build-specific licenses and notices must accompany deployment copies.

## Kenney sound effects

- Sources: [Interface Sounds](https://kenney.nl/assets/interface-sounds),
  [Impact Sounds](https://kenney.nl/assets/impact-sounds),
  [RPG Audio](https://kenney.nl/assets/rpg-audio), and
  [Sci-Fi Sounds](https://kenney.nl/assets/sci-fi-sounds).
- License: CC0 1.0 Universal.
- Source and verification record: `assets/licenses/Kenney-CC0.md`.

The eleven prepared effects derive from the user's existing local collection.
Original and prepared hashes are in `assets/manifest.json`. The original
download archives were unavailable; an archive-to-file comparison is not claimed.
Reference and hybrid SFX previews also contain these recordings.

## VSCO 2 Community Edition marimba

- Source: <https://github.com/sgossner/VSCO-2-CE>.
- Pinned commit: `440300901dfe9275fd84e0b7763af1f8443ae62e`.
- Credit: Sam Gossner / Versilian Studios and the VSCO contributors.
- License: CC0 1.0 Universal; copy at `assets/licenses/VSCO-CC0.txt`.

Six trimmed and normalized marimba notes are bundled. The hybrid cozy music
preview uses those notes. Pitch mapping and processing are documented in
`docs/ASSETS.md`; this project does not use an independently licensed conversion.
