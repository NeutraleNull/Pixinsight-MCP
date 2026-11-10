---
title: Stretch the stars and screen them in
summary: A midtones stretch of the linear star image, and a screen blend that leaves no dark rims.
status: tested
evidence: Two runs on IC 1871.
applies_to: [stars]
---

## Steps

1. Stretch the linear star image with PixelMath: `mtf(0.0008,$T)` as a start, or `mtf(0.0012,$T)` to let the nebula lead.
2. Look at full-resolution crops under `stretch: "none"`, and adjust the midtones value.
3. Put the stars into the starless image with a screen blend in PixelMath: `~(~nebula*~stars)`.
4. Make the combined image from a duplicate of the starless image, so that it keeps the metadata.

## Check the result

- Stars are small and round, and their cores are not flat: `clipping.high` at 0.99 stays at a few thousandths of a percent.
- No star has a dark rim against bright nebula.
- The sky median of the combined image equals that of the starless image.
