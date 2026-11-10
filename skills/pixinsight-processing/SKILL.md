---
name: pixinsight-processing
description: Process and judge astro images in PixInsight through the pixinsight MCP tools - gradients, sharpening, star removal, noise reduction, stretching, narrowband palettes such as SHO, stars, framing and export. Use for any image processing or image assessment task in PixInsight, from a single step to a whole workflow.
---

# Process images in PixInsight

What is known about processing lives in the processing library of the `pixinsight` MCP server, in small guides from real runs, matched to the processes installed here. Read them instead of working from memory.

1. Call `get_guide` without a name. It returns the catalog: workflows, practices, and stages with their methods.
2. Read the practices once, in one call, with a list of ids.
3. For a whole image, read the workflow that fits the data. For a single step, read its stage.
4. Read each stage when you get to it, and then the method you choose. A method says how to check that it worked: do that before you go on.

The values in the guides are starting points. Measure the data in front of you, and tell the user what you assumed.
