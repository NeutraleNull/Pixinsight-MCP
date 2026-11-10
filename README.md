# MCP server for PixInsight

Process your astro images together with an AI assistant, in your own [PixInsight](https://pixinsight.com/). You say what you want, the assistant looks at the image, measures it, and runs the processes. You see every step in your PixInsight window, and you can undo each one.

## Quickstart

You need PixInsight 1.9.4 or later, [Node.js](https://nodejs.org/) 20 or later, and an AI assistant that supports the Model Context Protocol (MCP), such as Claude Code.

1. Download `mcp-server-for-pixinsight-<version>.tgz` from the [latest release](../../releases/latest).

2. Tell your assistant where the file is. With Claude Code, run this once, with the full path set to the file:

   ```bash
   claude mcp add --scope user pixinsight -- npx -y --package /full/path/to/mcp-server-for-pixinsight-<version>.tgz mcp-server-for-pixinsight
   ```

   For opencode, Codex CLI, Gemini CLI, Claude Desktop, and others, see [Connect an assistant](docs/guides/connect-an-assistant.md).

3. Start PixInsight and open an image.

4. Ask your assistant:

   > Which images are open in PixInsight? Show me the first one, and tell me what you would do with it.

That is all. To go on, follow [Process your first image](docs/quickstart.md), or ask for a whole workflow:

```text
You: Remove the gradient from the Hα master and show me the result.

Assistant:
  get_guide        how to judge and remove a gradient
  run_process      GraXpert on Ha_master
  get_image_stats  background before and after
  get_preview      stretched view of the result
```

> [!NOTE]
> **AI disclosure:** This project is developed and maintained with the help of AI. Most of its code, tests, and documentation are written by an AI assistant, directed by a human maintainer, and checked by automated tests against a real PixInsight.

> [!IMPORTANT]
> This project is at an early stage. It has only been tested on Linux with PixInsight 1.9.6, and whole workflows only with Claude. Windows, macOS, and other assistants are prepared but not verified.

> [!IMPORTANT]
> This is an independent project. It is not made, certified, or endorsed by Pleiades Astrophoto. PixInsight is commercial software, and you need your own license for it.

## What it can do

- **Look and measure.** The assistant sees your images as previews and reads their statistics, so it judges by numbers as well as by eye.
- **Run any installed process,** including third-party ones such as BlurXTerminator, StarXTerminator, and GraXpert. New versions and modules work without an update to this server.
- **Follow tried workflows.** A processing library of small guides from real runs tells the assistant how to remove gradients, sharpen, stretch, build a narrowband palette, and check each step.
- **Run scripts** such as ImageSolver for you. The assistant reads the dialog of a script and what the script shows in it. If you turn it on, it also sets the dialog and presses its buttons, on your screen and without taking over your mouse.
- **Work with any model.** The server speaks MCP, so it works with Claude, GPT, Gemini, and others.

## Documentation

| Article | Use it to |
|---|---|
| [Quickstart](docs/quickstart.md) | Connect the server and process your first image |
| [Connect an assistant](docs/guides/connect-an-assistant.md) | Use the server with Claude, GPT, Gemini, or another model |
| [How the server works](docs/concepts.md) | Understand instances, jobs, and what keeps your work safe |
| [Process an image](docs/guides/process-an-image.md) | Look, measure, try settings, mask, save, and export |
| [Preprocess raw frames](docs/guides/preprocess-raw-frames.md) | Let the assistant calibrate, register, and integrate your frames with WBPP, without its dialog |
| [Run scripts and code](docs/guides/run-scripts-and-code.md) | Let the assistant start scripts such as ImageSolver and work their dialogs, and decide whether it may run its own code |
| [Handle dialogs, long jobs, and crashes](docs/guides/dialogs-jobs-crashes.md) | Know what to do when something does not go as planned |
| [Add a processing method](docs/guides/add-a-processing-method.md) | Teach the assistant a technique of your own, with one Markdown file |
| [Tool reference](docs/reference/tools.md) | Look up every tool, its parameters, and its response |
| [Error reference](docs/reference/errors.md) | Look up an error code and how to fix it |
| [Configuration reference](docs/reference/configuration.md) | Set the slot, mode, and paths |
| [Processing library format](docs/reference/processing-library.md) | Look up the fields and rules of a guide |
| [Architecture](docs/architecture.md) | Contribute: design, rules, and roadmap |
| [PixInsight behaviour reference](docs/reference/pixinsight-behaviour.md) | Look up how PixInsight behaves where the server depends on it |

## What it does differently

- **It uses PixInsight's documented command line.** There is no native module to compile or sign, no script running permanently inside PixInsight, and no network port.
- **It reads processes from your installation.** New versions and third-party modules work without an update to this server.
- **Its processing knowledge is open.** Workflows and methods are small Markdown files from real runs, checked against your installation. Anyone can [add one](docs/guides/add-a-processing-method.md).
- **It protects your work.** Every change can be undone, source files are not overwritten, and settings that could crash PixInsight are tried in a separate instance first. See [What keeps your work safe](docs/concepts.md#what-keeps-your-work-safe).

## What this changes, and for whom

> [!IMPORTANT]
> We know that a tool like this shifts something in astrophotography. Many of us are proud of the days we put into one image, and of the skill it took to learn processing. With an assistant, people without that experience get to much better images than before, and that can feel like it takes something away. 
> It also gives something. There are people who could not get there at all: because the craft takes years they do not have, because a red-green color deficiency makes judging a palette a guessing game, or because of more severe limitations that rule out hours of fine work at a screen. For them, this is the first real chance to make an image of the quality their data deserves.
> It is also not all or nothing. You do not have to hand the whole image to an assistant. You can keep the parts you love, and pass on the ones you do not: the tenth gradient removal of the night, the bookkeeping of saving every stage, or one step you want to repeat the same way on three channels. Used like that, it is a tool for single steps, and the image stays as much your work as you want it to be.
> Both are true. The photons are still yours, and so are the choices: what to shoot, what to show, and when an image is finished. We would rather have this conversation in the open than pretend the change is not happening. If you want to take part in it, open an issue.

## Build from source

To change the server or to try the newest state, build it yourself:

```bash
npm install
```

```bash
npm run build
```

Then use `node` with the absolute path to `dist/index.js` as the command of the server. In Claude Code, opening this folder is enough: approve the `pixinsight` server when asked. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

This project is free software under the [GNU General Public License](LICENSE), version 3 or any later version. You can use, change, and share it, as long as what you share stays under the same license. It comes without any warranty.

PixInsight itself is commercial software by Pleiades Astrophoto, and you need your own license for it. This repository contains no PixInsight or PCL source code. See [Licensing constraints](docs/architecture.md#licensing-constraints).

To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md).
