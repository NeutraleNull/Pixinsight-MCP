---
title: Stretch
summary: Bring each starless channel from linear to visible, with the same sky level in all channels.
---

Stretch each starless channel so that the sky ends at the same level in all of them, about 0.07 to 0.08. Then a combination starts from a neutral sky.

- Measure the sky of each channel first, in the same empty patch.
- Measure black clipping afterwards with `clipping.low`. Only a very small fraction may fall below.
- OIII and SII are usually weaker than Hα. Lift them above the sky afterwards, and do not subtract from a channel to darken its sky, because that clips the noise floor.

A strong stretch makes faint signal at the edges of the field visible. Sky patches then differ more, and the transition to the nebula looks harder. Check this before calling the sky flat.

From here on, use `stretch: "none"` in previews.
