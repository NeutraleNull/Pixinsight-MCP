---
title: Read the result of every process
summary: What to check in a run_process result before trusting a step, in order.
---

A process can report success and still have done nothing. Read the `run_process` result in this order:

1. `pixelsChanged: false` on a process that should change the image means it did nothing. Read `log` for the cause. A plugin calling a missing external program looks like this. A process that writes a new image or only metadata leaves its target unchanged, so check `newViews` and `metadataChanged` as well.
2. `log`. Computed results such as scale factors and sample counts are often only here. `outputs` holds only what the process has set, which is often nothing.
3. `applied`, to confirm the values that were really set.
4. `stats`, against the previous state.
5. `astrometryRemoved`, `previewsRemoved` and `maskRemoved`: the step deleted them. Undo brings them back.
6. `activeMask`: the image had a mask of its own, and the process ran through it. If you did not expect that, undo and ask the user.

A suspiciously short `seconds` on a demanding process is a warning sign too.
