---
title: SHO with a dynamic mix
summary: A Hubble palette close to the channels, in gold and teal, that keeps SII visible and avoids the green of a fixed assignment.
status: tested
evidence: One run on IC 1871. A purely dynamic mix came out too red there.
applies_to: [narrowband, stretched, starless]
---

## Steps

A fixed S→R, H→G, O→B assignment usually turns green. Use this with PixelMath instead, with one expression per channel, on the stretched starless `S`, `H` and `O`:

```text
a=O^~O;  r0=a*S+~a*H;  R=0.85*r0+0.15*S
b=(O*H)^~(O*H);  g0=b*H+~b*O
G=g0+0.62*(1-0.6*min(1,S/max(H,0.02)))*max(0,r0-g0)
B=O
```

Create the color image from a duplicate of a channel converted to RGB, so that it keeps the metadata.

## Check the result

- Warm regions have a hue of 40° to 45°, and no large area is green.
- SII-rich regions differ visibly from Hα-rich ones.
- The sky is close to neutral. If not, see `methods/enhance/neutral-sky`.
