---
title: Subtract halos of bright stars locally
summary: Remove the soft halo a bright star leaves in a starless channel, inside a circle around that star only.
status: experimental
evidence: One run on IC 1871, three stars in OIII and SII. The exact expression was not recorded, so this is an outline.
applies_to: [starless, linear]
---

## Steps

1. Find the halos in the starless channels, and note the center and radius of each. In one run, three stars left halos about 2.7 times above the noise in OIII, 1.6 times in SII, and hardly any in Hα.
2. Measure the sky level next to each halo.
3. Make a low-pass copy of the channel, with `Convolution` at a sigma of about 25.
4. With PixelMath, subtract the excess of the low-pass copy over the sky level, weighted by a soft circle around the star that falls to zero at its edge.

## Check the result

- The median inside the former halo equals the sky next to it. The strongest OIII halo went from 5.887e-4 to the sky level of 5.832e-4.
- Outside the circles, the image is unchanged: compare a patch far away before and after.
- No dark ring shows at the rim of a circle under a strong fixed stretch.
