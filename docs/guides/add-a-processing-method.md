# Add a processing method

This article shows how to add a method to the processing library, so that an assistant can use a technique you have worked out. You write one Markdown file. The server finds it by itself.

The library holds what an assistant knows about processing: which steps a workflow has, how to judge a stage, and how each method works. See the [format reference](../reference/processing-library.md) for every detail.

## Prerequisites

- This repository, built. See the [quickstart](../quickstart.md).
- A method you have used on real data, with the values you used and what you measured.
- To try it with an assistant: a running PixInsight.

## Step 1: Choose the stage

A method belongs to one stage, such as `stretch` or `gradient`. Each stage is a folder in `processing/methods`.

To see the stages and the methods they have, run:

```bash
npm run guides:check
```

If no stage fits, [add one](#add-a-stage-or-a-workflow).

## Step 2: Copy the template

Copy the template into the folder of the stage, under a name in lowercase letters, digits, and hyphens:

```bash
cp processing/templates/method.md processing/methods/stretch/arcsinh-stretch.md
```

The path becomes the ID of the method: `methods/stretch/arcsinh-stretch`.

## Step 3: Fill in the front matter

```yaml
---
title: Stretch with ArcsinhStretch
summary: Keeps star colors through the stretch. Choose it for broadband data with colorful stars.
status: experimental
evidence: One run on M45 at 400 mm, color camera, PixInsight 1.9.6.
requires: [ArcsinhStretch]
parameters: [ArcsinhStretch.stretch, ArcsinhStretch.blackPoint]
applies_to: [broadband, linear]
---
```

| Field | What to write |
|---|---|
| `title` | What the method does, starting with a verb. |
| `summary` | One or two sentences, at most 160 characters: what it does, and when to choose it. An assistant chooses by this line. |
| `status` | `experimental` until the method has held up on more than one data set, then `tested`. |
| `evidence` | Where your knowledge comes from: the object, the focal length, the kind of data. One run is fine, as long as you say so. |
| `requires` | The processes the method needs. The assistant then sees whether they are installed. |
| `parameters` | Every parameter the text names, as `Process.parameter`, or `Process.parameter=Constant` for a constant you pass. |
| `applies_to` | The kind of data: see the [reference](../reference/processing-library.md#applies_to). |

> [!TIP]
> Take parameter names from your own installation, not from memory: ask the assistant to call `describe_process`. A wrong name costs the assistant a failed run.

## Step 4: Write the steps and the check

A method has two sections, and both are required:

- **`## Steps`**: what to do, as numbered, imperative steps. Give the values from your run, and say how to adapt them to other data.
- **`## Check the result`**: how to tell that it worked, with something that can be measured, and the numbers from your run.

Add `## Limits` if you know where the method fails, or what it costs.

Keep it short: the limit is 80 lines. To point to another guide, write its ID in backticks, such as `` `practices/measure` ``.

## Step 5: Check the file

```bash
npm run guides:check
```

The command lists the library as an assistant sees it, and reports every problem with the file and the reason:

```text
1 problem(s):
  /home/you/PixInsightMCP/processing/methods/stretch/arcsinh-stretch.md
    A method needs the heading "## Check the result".
```

If PixInsight is installed, also check the parameter names against it:

```bash
npm run test:live
```

## Step 6: Try it with an assistant

Ask the assistant to read and apply your method:

> Read the guide methods/stretch/arcsinh-stretch and apply it to the image M45.

The server reads the files again on every call, so you can edit the file and ask again, without a restart. If the file has a mistake, the catalog of [`get_guide`](../reference/tools.md#get_guide) lists it under **Files with problems**.

When the method has passed a real run, open a pull request with the one file.

## Keep methods of your own

To use methods without contributing them, put them in a folder of your own with the same layout, and name it in [`PIXINSIGHT_MCP_GUIDE_DIRS`](../reference/configuration.md):

```text
~/my-methods/
  methods/stretch/arcsinh-stretch.md
```

A guide with the same ID as one that comes with the server replaces it. To check your folder, pass it to the command:

```bash
npm run guides:check -- ~/my-methods
```

## Add a stage or a workflow

- **A stage** is a file `processing/stages/<name>.md` with a `title` and a `summary`. Its text says what the stage is for, how to judge its result, and how to choose among its methods. The server adds the list of methods.
- **A workflow** is a file `processing/workflows/<name>.md`. It lists its `stages` in order, and its text mentions each as `` `stages/<name>` ``. A method you add to a stage shows up in every workflow that uses the stage.

## Rules for a contribution

- **Write from a real run.** Do not write down what should work.
- **Use your own words.** Do not copy from the PixInsight documentation, from tooltips, or from the documentation of plugins.
- **One technique per file.** Two ways to do something are two methods, and the stage says how to choose.
- **Say what it costs.** A method that hides its weak points gets used where it fails.

## Next steps

- [Processing library format](../reference/processing-library.md)
- [Tool reference: `get_guide`](../reference/tools.md#get_guide)
