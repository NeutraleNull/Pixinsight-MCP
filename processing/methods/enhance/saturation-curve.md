---
title: Add saturation with a curve
summary: A gentle saturation curve through the nebula mask, which leaves the sky alone.
status: tested
evidence: Two runs on IC 1871, on the combined starless image.
requires: [CurvesTransformation]
parameters: [CurvesTransformation.S]
applies_to: [stretched, starless, color]
---

## Steps

Run `CurvesTransformation` with the saturation curve in `S`, as a table of points with the columns `x, y`, through the nebula mask:

```json
{ "S": [[0, 0], [0.5, 0.6], [1, 1]] }
```

To leave weakly saturated areas alone, add a point such as `[0.12, 0.12]`.

## Check the result

- The saturation of a nebula region rises. In one run, the mean in the nebula went from 0.48 to 0.59 over the whole processing.
- The sky median and its channel balance stay the same.
- No region clips: check `clipping.high` per channel.
