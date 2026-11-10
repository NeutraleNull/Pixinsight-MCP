---
title: Try settings on a small region
summary: When to use a preview and when a copy of a region, because steps on a preview do not add up.
---

Trying on a small region takes seconds instead of a minute. A 700×500 copy takes BlurXTerminator 2 s and StarXTerminator 1 s.

| You want to | Use | Why |
|---|---|---|
| See what one step does | A preview, from `create_preview` | Fast, and the main image stays untouched. Each run starts again from the main image, so steps do not add up: the result says `startedFromMainImage` |
| Try a chain of steps | A copy of a region, from `duplicate_image` with `rect` | Steps add up as they will on the real image |
| Try a plugin that makes new images, such as a star layer | The same copy | On a preview of a plate-solved image, StarXTerminator opened a modal error dialog in PixInsight, and the star layer got a wrong solution. On a copy neither happened |

Do not judge a later step on a preview. In one run, sharpening looked bad on a preview because it had run on the image before noise reduction, not after it.
