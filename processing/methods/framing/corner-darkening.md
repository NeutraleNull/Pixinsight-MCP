---
title: Darken the corners slightly
summary: A soft multiplicative falloff towards the corners that holds the eye in the image and keeps the hues.
status: experimental
evidence: One run on IC 1871, on a 4:5 crop. The user accepted the result.
applies_to: [stretched, color]
---

This is design, so say so.

## Steps

Apply this with PixelMath to the cropped image, with `cx` and `cy` as half its width and height:

```text
dx=(x()-cx)/cx; dy=(y()-cy)/cy; r=sqrt((dx*dx+dy*dy)/2)
t=max(0,min(1,(r-0.6)/0.4)); $T*(1-0.22*t*t*(3-2*t))
```

Because it multiplies, the hues stay the same. PixelMath needs `dx`, `dy`, `r` and `t` in `symbols`.

## Check the result

- The corners are darker by a factor of about 0.79, and the middle of an edge by about 0.975.
- The center is unchanged.
- No band or ring is visible under a strong fixed stretch.
