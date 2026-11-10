---
title: Reduce noise with NoiseXTerminator
summary: AI noise reduction, strong on linear starless channels and gentle on a stretched image.
status: tested
evidence: Two runs on IC 1871 at 752 mm, on a CPU.
requires: [NoiseXTerminator]
parameters: [NoiseXTerminator.denoise, NoiseXTerminator.detail]
applies_to: [starless]
---

## Steps

1. On each linear starless channel, run `NoiseXTerminator` with `denoise: 0.7` to `0.8` and `detail: 0.15` to `0.2`. One run used 0.75 and 0.2 for Hα, and 0.8 and 0.15 for the weaker OIII and SII.
2. If the stretched color image is still noisy, run it once more with `denoise: 0.4` and `detail: 0.2`.

A 23-megapixel image took 59 to 71 s on a CPU, and a 1000×800 copy 3.5 s.

## Check the result

- The MAD of an empty sky patch drops. After step 1 it was 2.8e-6 for Hα and 2.0e-6 for OIII. Step 2 brought the stretched sky from 0.011 to 0.0068.
- Faint structures are still there in a full-resolution crop, and the texture does not look plastic.
