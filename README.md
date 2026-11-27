# PNG Squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/draco-malfoy-ovo/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/draco-malfoy-ovo/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG recompressor, written from scratch in a single `main.ts` using only Node.js built-in modules. It reads eight 1280×720 screenshots from `/input/i001`–`i008` and writes a strictly smaller, pixel-identical PNG for each into `/output/<id>/image.png`.

How it squeezes:

1. **Decode and analyse** each image (distinct colours, greyness, opacity, transparency key).
2. **Candidate colour forms** — palette by colour count, palette by luminance, grey, grey+alpha, RGB, RGBA, or a tRNS-keyed form — whichever fits the actual pixels.
3. **Filter screening** (fixed filters 0–4, minimum-sum, fewest-pairs), each candidate weighed with zlib level 6; the winner on larger instances is refined with per-row brute-force filter choice.
4. **Final deflate** picks the best of several zlib level-9 configurations.

Everything is deterministic: work is budgeted by data size, never by the clock, and two runs produce byte-identical output. Outputs use only IHDR/PLTE/tRNS/IDAT/IEND chunks, bit depth 8, non-interlaced, a single zlib stream in one IDAT.

Local score on the kit's practice set (the official `grade-local`): **705,347 / 1,000,000**, all 8 instances passing — against the fixed-paeth 1.0.0 baseline's 420,399 on the same set. A full run takes about 12 seconds of the 60-second sandbox budget.
