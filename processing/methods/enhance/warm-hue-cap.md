---
title: Keep dark gold from turning olive
summary: Cap warm hues by lowering green only, more strongly in dark areas, where gold looks greenish sooner.
status: experimental
evidence: One run on IC 1871. The exact expression was not recorded, so this is an outline.
applies_to: [stretched, starless, color]
---

## Steps

1. Measure the hue of warm regions, bright and dark. The same hue looks more greenish at low brightness.
2. Where the hue of a warm pixel is above the cap, lower its green channel until the hue is at the cap. Leave red and blue as they are.
3. Let the cap depend on brightness: about 34° in dark areas, rising to 45° in bright ones.

## Check the result

- The share of olive pixels in the nebula drops. In one run it went from 10.9 % to 2.4 % between two versions.
- A region that was at 55° is now near 41°.
- Blue and turquoise regions are unchanged.
