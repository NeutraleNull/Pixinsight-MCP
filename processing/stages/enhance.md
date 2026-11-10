---
title: Enhance contrast and color
summary: Local contrast, saturation and a neutral sky on the combined starless image, always through a mask.
---

Work on the starless color image, and through a mask that protects the sky, so that the sky stays as it is. Pass the mask in the `mask` parameter of `run_process`.

Build the mask from the brightness of the image, smoothed, so that it has no hard edges.

Measure before and after each method: the sky median, the hue of a warm and a blue region, and the saturation.

Tried and dropped in one run: `HDRMultiscaleTransform`, which lifted the sky to 0.18 and looked flat, and `UnsharpMask`, which looked wormy on a denoised image.
