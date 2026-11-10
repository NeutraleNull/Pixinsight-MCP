---
title: SHO from separate brightness and color
summary: A designed palette in amber, rust and turquoise, with a luminance from all channels. More depth, less direct.
status: experimental
evidence: One run on IC 1871, and one measurement of six variants on its lower bubble.
applies_to: [narrowband, stretched, starless]
---

## Steps

1. **Luminance.** Screen the channels above the sky: `a=0.75*(H-0.07); b=0.55*(S-0.07); c=0.55*(O-0.07); 0.07+0.93*(1-(1-a)*(1-b)*(1-c))`. Add local contrast through a nebula mask, as in `methods/enhance/local-contrast-lhe`, at radius 220 (`slopeLimit: 1.6`, `amount: 0.55`) and at radius 70 (`1.4`, `0.35`).
2. **Color** from the shares of the emissions, from channels smoothed with a sigma of 3, so that no color noise appears:

   ```text
   h=0.62*max(0,Hc-0.07); s=0.68*max(0,Sc-0.07); o=0.85*max(0,Oc-0.07)
   a=h^g; b=s^g; c=o^g; n=0.0012^(g/2.2); t=a+b+c+n
   cr=(a+b+c*0.02+n)/t;  cg=(a*0.75+b*0.24+c*k+n)/t;  cb=(a*0.25+b*0.15+c+n)/t
   m=max(cr,max(cg,cb));  R=L*cr/m;  G=L*cg/m;  B=L*cb/m
   ```

   Hα becomes amber, SII rust, OIII turquoise. PixelMath needs these names in `symbols`. The term `n` turns the color neutral where there is no signal, so the sky needs no mask. It has to follow `g`, or dark areas turn slate blue.
3. **Choose `k` and `g`.** Start with `k=0.85` and `g=3.5`.
4. **Add the structure of weak channels** back into the luminance where they dominate, if Hα outshines them. Without this, the rings in OIII were lost.

## Check the result

Measure where OIII meets a warm color. "Mixed" is the share of the area where OIII holds 25 % to 60 %, which is what reads as a milky rim:

| `k` | `g` | Look of OIII | Mixed | Saturation there | Saturation in OIII |
|---|---|---|---|---|---|
| 0.66 | 2.2 | Sky blue, wide gray rim | 41 % | 0.27 | 0.45 |
| 0.85 | 2.2 | Turquoise, wide rim | 41 % | 0.34 | 0.50 |
| 0.85 | 3.5 | Clean turquoise | 28 % | 0.37 | 0.57 |
| 0.85 | 4.5 | Strong, with harder edges | 22 % | 0.37 | 0.60 |
| 0.75 | 3.5 | Bluer | 28 % | 0.33 | 0.53 |

The sky must stay neutral: 0.0694, 0.0694 and 0.0694 in one run.

## Limits

- Warm and cyan mix to gray-green in between, and no mix avoids that. A steeper `g` only makes that zone narrower. Darkening it made the image muddy.
- A larger `k` makes OIII greener: 1.0, with blue at 0.95, already looked green.
- The table comes from a part of one image. The values 0.85 and 3.5 have not been judged on a whole image.
