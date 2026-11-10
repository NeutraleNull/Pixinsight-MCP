---
title: Stretch with HistogramTransformation
summary: A plain midtones stretch with values chosen from measured sky statistics.
status: tested
evidence: One run on IC 1871 at 752 mm, starless narrowband channels.
requires: [HistogramTransformation]
parameters: [HistogramTransformation.H]
applies_to: [linear]
---

## Steps

1. Measure the median and MAD of an empty sky patch.
2. Choose the black point `c0` a little below the sky, and the midtones balance `m` so that the sky ends at about 0.08.
3. Run `HistogramTransformation`. Its table `H` has one row per channel, in the order R, G, B, RGB/K and alpha, with the columns `c0, m, c1, r0, r1`. For a grayscale image, set the fourth row and leave the others at `[0, 0.5, 1, 0, 1]`.

## Check the result

- `applied` shows the table as it was set.
- The sky median is at the level you aimed for.
- Measure `clipping.low` at 0.005. Lower `c0` if more than a very small fraction falls below it.
