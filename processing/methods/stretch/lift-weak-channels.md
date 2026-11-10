---
title: Lift weak channels above the sky
summary: Raise OIII and SII towards Hα after stretching, without moving the sky.
status: tested
evidence: Two runs on IC 1871, OIII and SII against Hα.
applies_to: [stretched, starless, narrowband]
---

## Steps

Apply this with PixelMath to a stretched channel, with `S0` a little above its sky level, and a gain `g`:

```text
d=max(0,$T-S0); $T+g*d*(1-$T)*d/(d+0.05)
```

One run used `S0=0.085` for a sky of 0.07, with `g=1.6` for OIII and `g=1.3` for SII. PixelMath needs `d` in `symbols`.

## Check the result

- The sky median is unchanged.
- The maximum stays below 1, and `clipping.high` does not rise.
- The channel now reaches a brightness comparable to Hα in its strongest areas.

## Limits

Do not subtract from a channel to darken its sky instead. That clips the noise floor.
