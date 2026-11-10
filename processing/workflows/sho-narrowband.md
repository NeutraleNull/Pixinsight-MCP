---
title: Process SHO narrowband data
summary: From linear Hα, OIII and SII masters to a finished Hubble palette image, with stars from the narrowband data.
status: experimental
evidence: Two runs on IC 1871 at 752 mm, 3.76 µm pixels, 300 s subframes. One field proves little.
stages: [inputs, gradient, sharpen, star-separation, noise, repair, stretch, combination, enhance, stars, export, framing]
applies_to: [narrowband, mono]
---

Read the practices first, in one call: `practices/equipment`, `practices/protect-work`, `practices/read-results`, `practices/measure`, `practices/look` and `practices/try-settings`.

Then read each stage when you get to it. A stage lists its methods, with what each needs.

## Linear, per channel

1. **Check the inputs:** `stages/inputs`.
2. **Correct gradients:** `stages/gradient`. Check the sky of all channels afterwards.
3. **Sharpen:** `stages/sharpen`, before removing stars.
4. **Save** the linear state of every channel now.
5. **Separate the stars:** `stages/star-separation`. Keep each star image.
6. **Reduce noise** on the starless channels: `stages/noise`.
7. **Repair** halos of bright stars, if there are any: `stages/repair`.

## Stretched

8. **Stretch** each starless channel to the same sky level: `stages/stretch`. Then lift OIII and SII, with `methods/stretch/lift-weak-channels`.
9. **Combine** the channels: `stages/combination`. Ask the user how much design they want, or show two palettes.
10. **Enhance** contrast and color: `stages/enhance`.
11. **Bring the stars back:** `stages/stars`.

## Finish

12. **Check the result,** as `practices/finish-and-report` describes.
13. **Write the uncropped files:** `stages/export`.
14. **Add depth,** if the user wants it: `methods/enhance/depth-layers`, as a version of its own.
15. **Frame the image:** `stages/framing`, and write the cropped files too.
16. **Report,** as `practices/finish-and-report` describes.

## Known weak points

- Near very bright stars, sharpening can strengthen an arc of small dots.
- Star removal can smear the nebula beneath dense star clusters.
- Where a warm color meets OIII, the mix turns gray. See `methods/combination/sho-luminance-and-color`.
