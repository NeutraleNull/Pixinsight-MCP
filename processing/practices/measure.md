---
title: Measure instead of guessing
summary: Which number answers which question about an image: gradients, neutral sky, clipping, noise and color.
---

A preview shows an impression. Numbers decide. Trust a step only after both agree.

Use `get_image_stats` with `rect`, or with `rects` for several patches in one call. No duplicate, crop or temporary image is needed.

| Question | How to measure | Reading it |
|---|---|---|
| Is there a gradient left? | Median of 3 to 4 empty-sky patches across the image | Equal within a few 1e-6 in linear data. Check that a patch is really empty first |
| Is the sky neutral? | Median per channel of one sky patch | Channels equal after stretching |
| Are the blacks clipped? | `clipping.low` near 0, and the mean against the median of a sky patch | Mean clearly below median suggests a clipped noise floor, even if few samples hit zero |
| Are the highlights clipped? | `clipping.high: 0.99` | A small fraction from star cores is fine. Check nebula separately on a starless image |
| How strong is the noise? | MAD of a sky patch | Compare only between images at the same processing stage |
| Is a color what it looks like? | Mean per channel of a region, converted to hue | Gold sits near 40° to 45° in bright areas. Below that it turns orange, above it olive and green. Dark gold already looks olive at 45°, so keep it at 34° to 40° |
| Is a transition milky? | Saturation, (max-min)/max, where a warm color meets a cyan one | In one field, 0.27 looked milky and gray, and 0.37 looked clean |

Lower MAD after gradient correction can mean that real signal was removed, not that the image improved.
