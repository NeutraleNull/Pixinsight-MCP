---
title: Sharpen with BlurXTerminator
summary: AI deconvolution of a linear channel, with moderate values that held up on narrowband data.
status: tested
evidence: Two runs on IC 1871 at 752 mm, 3.76 µm pixels, on a CPU.
requires: [BlurXTerminator]
parameters: [BlurXTerminator.sharpen_stars, BlurXTerminator.sharpen_nonstellar]
applies_to: [linear]
---

## Steps

1. Save the image first. It is the most demanding step so far.
2. Run `BlurXTerminator` with `sharpen_stars: 0.25` and `sharpen_nonstellar: 0.4`, on each channel.

A 23-megapixel channel took 65 to 80 s on a CPU, and a 700×500 copy 2 s.

## Check the result

- `pixelsChanged` is `true`, and `seconds` is plausible for the image size.
- In a full-resolution crop, stars are smaller and round, without dark rings.
- Around the brightest star, check for an arc of small dots.
