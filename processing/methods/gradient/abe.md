---
title: Subtract a plane with AutomaticBackgroundExtractor
summary: A degree 1 background model, for a band without reference data, such as SII. Check its direction afterwards.
status: tested
evidence: Two runs on IC 1871 at 752 mm, SII. In the second, the plane removed real signal on one side.
requires: [AutomaticBackgroundExtractor]
parameters: [AutomaticBackgroundExtractor.polyDegree, AutomaticBackgroundExtractor.targetCorrection=Correction_Subtract, AutomaticBackgroundExtractor.normalize, AutomaticBackgroundExtractor.useBrightnessLimits, AutomaticBackgroundExtractor.minBackground, AutomaticBackgroundExtractor.maxBackground, AutomaticBackgroundExtractor.replaceTarget]
applies_to: [linear]
---

## Steps

1. Measure the sky level of the image in an empty patch.
2. Run `AutomaticBackgroundExtractor` with:
   - `polyDegree: 1`, so that the model cannot follow nebula shapes.
   - `targetCorrection: "Correction_Subtract"`.
   - `normalize: true`. Without it the image is rescaled: in one run to min 0, max 1 and a median of 0.000115 instead of 0.000588, which changes the flux of this channel against the others without any warning. The log then says `Rescaling pixel samples`.
   - `useBrightnessLimits: true`, with `minBackground` and `maxBackground` around the measured sky level, so that the samples stay out of the nebula. One run used 0.00055 and 0.000597 for a sky of 0.000588.
   - `replaceTarget: true` to correct the target. Without it, the result is a new image: check `newViews`.

## Check the result

- Read the number of samples from `log`.
- The background model has half the size of the image with the default settings. Compare it visually, not pixel by pixel.
- Check the direction of the plane against the other channels, as `stages/gradient` describes. In one run it ran against the real gradient.
