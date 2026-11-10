---
title: Write the files
summary: Save the working image and export files for sharing, and report what each file really holds.
---

- **The working file:** `save_image` as XISF. It becomes the path of the image in PixInsight.
- **Files for sharing:** `export_image`, which leaves the image in PixInsight untouched. For example a JPEG with `quality: 95`, and a TIFF with `bitsPerSample: 16`.

Both responses say what the file really holds: `keywords`, `properties` and `astrometry`, read back from the file. JPEG and TIFF keep next to nothing, so only the XISF stays plate-solved.

Both tools create the folder if needed, and refuse to replace a file unless `overwrite` is set. If a name is taken, choose another one, or ask the user: the file may be the result of an earlier run.
