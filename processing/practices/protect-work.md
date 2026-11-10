---
title: Protect the work
summary: Habits that keep a crash, a wrong step or a lost solution from costing more than a few minutes.
---

- **Save at every stage,** with `save_image` under a stage number, into a folder of its own next to the masters. The tool creates the folder. A crash loses everything that is not saved. In one run, a saved stage limited a crash to a few minutes of lost work.
- **Never change the masters.** `open_image` opens a protected copy. Write results to new files, and give a second run a folder of its own instead of replacing the files of the first.
- **Keep metadata.** Copy with `duplicate_image`. `PixelMath` with `createNewImage` drops FITS keywords and the astrometric solution, and every image derived from it stays without them.
- **Keep the set of open images small.** Close intermediate images once they are saved. `close_image` takes a list. To discard unsaved ones, name each of them in `discardChanges`, and only your own temporary images.
- **Undo your own step, not the user's.** Pass the `historyIndex` from your `run_process` result to `undo`. The user works in the same images.
- **Expect waits.** On a CPU, a 23-megapixel channel takes about a minute for an AI-based process. Use `waitMs` and `get_job`, and never resend a pending job.
- **Be careful with plugins you have not used in this session.** Save first, and try them on a small copy from `duplicate_image` with `rect`. A process can crash PixInsight regardless of its parameters.
