---
title: Stretch with MultiscaleAdaptiveStretch
summary: Puts the sky at a chosen level and brings out structure in dust and faint nebulosity.
status: experimental
evidence: One run on IC 1871 at 752 mm, starless narrowband channels. It showed clearly more dust structure than a histogram stretch.
requires: [MultiscaleAdaptiveStretch]
parameters: [MultiscaleAdaptiveStretch.aggressiveness, MultiscaleAdaptiveStretch.targetBackground, MultiscaleAdaptiveStretch.dynamicRangeCompression, MultiscaleAdaptiveStretch.contrastRecovery, MultiscaleAdaptiveStretch.scaleSeparation, MultiscaleAdaptiveStretch.backgroundROIEnabled, MultiscaleAdaptiveStretch.backgroundROIX0, MultiscaleAdaptiveStretch.backgroundROIY0, MultiscaleAdaptiveStretch.backgroundROIWidth, MultiscaleAdaptiveStretch.backgroundROIHeight]
applies_to: [linear, starless]
---

## Steps

1. Choose a region of empty sky as the background reference, the same one for all channels. One run used 400×400 pixels.
2. Run `MultiscaleAdaptiveStretch` on each channel with the same values:
   - `targetBackground: 0.07`
   - `aggressiveness: 0.7`
   - `dynamicRangeCompression: 0.4`
   - `contrastRecovery: true`
   - `scaleSeparation: 1024`
   - `backgroundROIEnabled: true`, with the region in `backgroundROIX0`, `backgroundROIY0`, `backgroundROIWidth` and `backgroundROIHeight`.

It took under a second per 23-megapixel channel.

## Check the result

- The sky median of every channel is at the target. In one run it was exactly 0.0700 in all three.
- `clipping.low` at 0.005 is near zero.
- Compare the channels under `stretch: "none"`.
