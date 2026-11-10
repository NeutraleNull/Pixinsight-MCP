---
title: Star color from narrowband star images
summary: Combine the linear star images of Hα, OIII and SII into RGB stars without a magenta cast.
status: tested
evidence: Two runs on IC 1871. Not calibrated against a catalog.
applies_to: [narrowband, linear, stars]
---

## Steps

Combine the linear star images with PixelMath, with one expression per channel. Green is built between red and blue, which avoids magenta:

```text
R=f*max(0,(H+S)/2-3e-6);  B=max(0,O-3e-6);  G=(R+B)/2
```

- The small floor removes faint residues of the star removal.
- Choose `f` so that the mean star flux of red and blue is equal. It was 1.12 in two runs, for mean fluxes of 1.97e-5 in Hα, 2.34e-5 in OIII and 2.22e-5 in SII.

## Check the result

- The means of the red and the blue channel agree.
- After stretching, stars range from orange to blue-white, and none is magenta or green.

## Limits

The colors are plausible, not measured: narrowband filters do not give real star colors.
