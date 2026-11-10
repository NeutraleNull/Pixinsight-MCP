---
title: Remove stars with StarXTerminator
summary: AI star removal on a linear channel, with a separate star image for later.
status: tested
evidence: Two runs on IC 1871 at 752 mm, linear narrowband channels, on a CPU.
requires: [StarXTerminator]
parameters: [StarXTerminator.stars, StarXTerminator.unscreen, StarXTerminator.remove_spikes, StarXTerminator.remove_reflections, StarXTerminator.remove_aureoles]
applies_to: [linear]
---

## Steps

1. Run `StarXTerminator` with `stars: true` and `unscreen: false`, on each channel. Without `stars` there is no star image.
2. Take the star image from `newViews`, and give both images clear names when you save them.

A 23-megapixel channel took 41 to 43 s on a CPU, and a 700×500 copy 1 s.

## Check the result

- `newViews` holds one star image. If it is empty, `stars` was not set.
- The starless image shows no star cores in a full-resolution crop.
- A preview of the star image shows small, separate stars.

## Limits

On linear data, `remove_spikes`, `remove_reflections` and `remove_aureoles` showed no effect: the statistics stayed bit-identical with all three on or off.
