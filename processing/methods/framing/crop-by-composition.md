---
title: Choose a crop by composition
summary: Compare several crops before cutting, place the main structures, and say what the crop costs.
status: tested
evidence: One run on IC 1871. The user chose a 4:5 portrait over 1:1 and a wide crop.
requires: [Crop]
parameters: [Crop.mode=AbsolutePixels, Crop.leftMargin, Crop.rightMargin, Crop.topMargin, Crop.bottomMargin]
applies_to: [stretched, color]
---

## Steps

1. **Compare at least three crops** with `get_preview` and `crop`, which changes nothing. Look for the format of the subject, and do not just cut off empty sky. Two bubbles above each other suited a 4:5 portrait.
2. **Place the main structures** near the thirds. Leave a calm band rather than a large empty area. Avoid cutting an object at its tip, and shift the crop a little if needed.
3. **Say what the crop costs.** Name what leaves the image.
4. **Crop a duplicate** with `Crop`, `mode: "AbsolutePixels"`, and negative margins, such as `leftMargin: -1790` and `rightMargin: -797`. That keeps every pixel as it is, without interpolation.

## Check the result

- The size is what you computed: 5743 wide minus 1790 and 797 gave 3156.
- The result names what the crop deleted: `astrometryRemoved` for a plate solution that cannot be transformed, `previewsRemoved`, and `maskRemoved`. On a duplicate made for the crop, only the first is expected.
- A patch in the center has the same statistics as in the uncropped image.
