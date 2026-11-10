---
title: Add local contrast with LocalHistogramEqualization
summary: Bring out structure in the nebula through a brightness mask, so that the sky stays untouched.
status: tested
evidence: Two runs on IC 1871, on the combined starless image and on a luminance.
requires: [LocalHistogramEqualization]
parameters: [LocalHistogramEqualization.radius, LocalHistogramEqualization.slopeLimit, LocalHistogramEqualization.amount]
applies_to: [stretched, starless]
---

## Steps

1. Build a smoothed brightness mask of the nebula.
2. Run `LocalHistogramEqualization` with `radius: 128`, `slopeLimit: 1.6` and `amount: 0.35`, with the mask in the `mask` parameter of `run_process`.

A larger radius works on larger structures: one run used 220 with an `amount` of 0.55, and then 70 with a `slopeLimit` of 1.4 and an `amount` of 0.35.

## Check the result

- The sky median is bit-identical before and after: 0.06943610 in one run.
- The result has `mask`, and `list_images` shows no mask on the image afterwards.
- A full-resolution crop shows more structure, without blotches in smooth areas.
