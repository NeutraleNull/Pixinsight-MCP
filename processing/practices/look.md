---
title: Look at an image
summary: How to use get_preview so that what you see can be trusted, and what misleading previews look like.
---

- **Start with the whole image,** then crop. A `crop` that fits into `maxSize` is at full resolution. Use it for stars, edges, dark clouds, and the rim of a mask.
- **Use at least 1400 pixels** for a judgment of the whole image. Smaller previews hide faint gradients.
- **Compare under the same stretch.** The automatic stretch adapts to each image, so two versions can look different when they are not, and the same when they are not. Use `stretchFrom`, or pass the `stf` of the earlier preview.
- **Use `linked: true`** to judge the color balance of a linear RGB image. The default stretches each channel alone and hides casts.
- **Use `stretch: "none"`** once an image is stretched. Then the preview shows what the file holds.

## When a preview misleads

| What you see | Likely cause | What to do |
|---|---|---|
| A star layer shows only stars, and no faint residues | For an almost empty image the stretch follows the brightest pixels: the response says `stretch: "auto sparse"` | Fine for judging stars. To look for residues, pass a stronger `stf`, with a smaller first value |
| One version looks noisier | Each preview has its own stretch | Compare under the same `stf` |
| Colors differ slightly from PixInsight | The JPEG has no color management | Measure the color, and let the user judge the final look |
| A warm cast in empty sky | Faint real signal, or a transition zone | Measure a truly empty patch before correcting anything |
