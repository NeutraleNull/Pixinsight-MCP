# Processing library

What an assistant should know about processing astro images in PixInsight, in small files. The server hands them out through the `get_guide` tool, and finds new files by itself: nothing has to be registered.

| Folder | Holds | Example |
|---|---|---|
| `workflows/` | The order of stages for one kind of data | `workflows/sho-narrowband.md` |
| `stages/` | What a stage is for, how to judge it, and how to choose a method | `stages/gradient.md` |
| `methods/<stage>/` | One technique: its steps, and how to check that it worked | `methods/gradient/mars.md` |
| `practices/` | What applies to every task | `practices/measure.md` |

To add a method, copy `templates/method.md` into the folder of its stage, fill it in, and run:

```bash
npm run guides:check
```

The how-to is in [Add a processing method](../docs/guides/add-a-processing-method.md), and every field in the [format reference](../docs/reference/processing-library.md).

Three rules matter most:

- **Write from a real run,** and say which one in `evidence`. One run on one field is fine, as long as the guide says so.
- **Say how to check the result,** with something that can be measured.
- **Use your own words.** Do not copy from the PixInsight documentation, from tooltips, or from the documentation of plugins.

A guide you contribute is published under the license of this project, the [GNU General Public License](../LICENSE), version 3 or later.
