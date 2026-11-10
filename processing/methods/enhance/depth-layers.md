---
title: Add depth with dust and glow layers
summary: Make dust lie in front of glowing gas, and layer the stars. Pure design, as a version of its own.
status: experimental
evidence: One run on IC 1871, on request of the user. It raised local contrast by 4 % at small and 19 % at large scales.
applies_to: [stretched, color]
---

The eye reads depth from occlusion, light from behind, color and layering. The image holds no measured distance, so say that this is design. Work on the separate starless and star layers, and keep the version without it.

## Steps

1. **Map the dust.** From the brightness `V0=max(R,G,B)`, smoothed with sigma 2, 10, 30 and 120: `w=max(0,min(1,(V120-0.10)/0.12)); Dust=w*min(1,1.15*max(0,V30-V2)/V30+0.45*max(0,V120-V10)/V120)`. A weight of 0.9 instead of 0.45 looked blotchy.
2. **Put glow behind the dust.** `Glow` is the bright areas, `$T*max(0,min(1,(V2-0.35)/0.3))`, smoothed with sigma 45. Apply the glow first and darken afterwards, so that the silhouettes lie in front of the light: `g=1-(1-Neb)*(1-0.20*Glow); d=1-0.50*Dust; c=1+w*(V0^0.10-1); g*d*c`.
3. **Bring the color back,** because the glow takes saturation away: a saturation curve through (0.12, 0.12), (0.5, 0.6) and (0.85, 0.9).
4. **Layer the stars.** Weaken faint stars with `$T^1.25`, give bright ones a small halo, and dim those in the dust by up to 35 % with `1-0.35*Dust`. Whether a star really lies behind the dust is not known.

## Check the result

- The sky median is the same as before.
- Local contrast is higher at large scales, and edges show no dark seams at full resolution.
- Compare with the version before, side by side, and let the user choose.

## Limits

The bubble looked more restless afterwards, and many faint stars got weaker. The numbers only show more contrast, not more space.
