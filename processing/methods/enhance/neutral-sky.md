---
title: Neutralize the sky
summary: Bring the channels of the empty sky to the same level, inside a sky mask only.
status: experimental
evidence: One run on IC 1871, after a dynamic SHO mix. The exact expression was not recorded, so step 3 is an outline.
applies_to: [stretched, starless, color]
---

## Steps

1. Measure the median per channel in a patch that is truly empty. A warm cast in a patch near the nebula can be faint real signal.
2. Build a sky mask: the inverse of the nebula mask.
3. With PixelMath, through the sky mask, shift each channel by the difference between its median and the mean of the three medians.

Skip this if the palette makes the sky neutral by itself, as `methods/combination/sho-luminance-and-color` does.

## Check the result

- The medians of the three channels in the sky patch agree to the third decimal place.
- A patch inside the nebula is unchanged.
