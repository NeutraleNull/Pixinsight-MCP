---
title: Check the inputs
summary: Confirm that the masters fit together before any processing.
---

1. Open each master with `open_image`. It opens a protected copy, and keeps only the first image of a file, because masters can carry extras such as a crop mask.
2. Compare the statistics of the channels with `get_image_stats`. Note the sky median and MAD of each: later stages build on them.
3. Confirm in full-resolution crops of two opposite corners that the stars of all channels coincide. In one run, 500×350 crops at the top left and the bottom right were enough.

If the stars do not coincide, stop and tell the user. The channels then need registration, which belongs before this workflow.
