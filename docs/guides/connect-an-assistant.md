# Connect an assistant

The server works with any assistant that speaks the Model Context Protocol (MCP), whatever model runs behind it. In this guide, you add the server to your client, check the connection, and learn what your model needs to do good work.

## Prerequisites

- The release file `mcp-server-for-pixinsight-<version>.tgz` from the [latest release](../../../../releases/latest), or a [build from source](../../README.md#build-from-source).
- [Node.js](https://nodejs.org/) 20 or later.
- A client that can start a local MCP server over standard input and output. Most coding assistants and desktop apps can.
- A model that can call tools and look at images. See [What the model needs](#what-the-model-needs).

## Add the server to your client

Every client needs to know how to start the server: a command, and its arguments.

| You have | Command | Arguments |
|---|---|---|
| A release file | `npx` | `-y`, `--package`, the full path to the `.tgz` file, and `mcp-server-for-pixinsight` |
| A build from source | `node` | The full path to `dist/index.js` |

The examples use the release file. Settings such as the mode go into environment variables, which the [configuration reference](../reference/configuration.md) lists.

### Claude Code

```bash
claude mcp add --scope user pixinsight -- npx -y --package /full/path/to/mcp-server-for-pixinsight-<version>.tgz mcp-server-for-pixinsight
```

If you work in a build from source, open Claude Code in that folder instead, and approve the `pixinsight` server when asked. To install that folder as a plugin, which also brings a skill that leads the assistant to the processing library, run:

```bash
claude plugin marketplace add /absolute/path/to/PixInsightMCP
```

```bash
claude plugin install pixinsight@pixinsight-mcp
```

### opencode

Add the server to `opencode.json`, in your project or in `~/.config/opencode/`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "pixinsight": {
      "type": "local",
      "command": ["npx", "-y", "--package", "/full/path/to/mcp-server-for-pixinsight-<version>.tgz", "mcp-server-for-pixinsight"],
      "enabled": true
    }
  }
}
```

Then check that the server answers:

```bash
opencode mcp list
```

```text
●  ✓ pixinsight connected
│      npx -y --package /full/path/to/mcp-server-for-pixinsight-0.1.0.tgz mcp-server-for-pixinsight
```

### Codex CLI

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.pixinsight]
command = "npx"
args = ["-y", "--package", "/full/path/to/mcp-server-for-pixinsight-<version>.tgz", "mcp-server-for-pixinsight"]
```

### Gemini CLI

Add the server to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "pixinsight": {
      "command": "npx",
      "args": ["-y", "--package", "/full/path/to/mcp-server-for-pixinsight-<version>.tgz", "mcp-server-for-pixinsight"]
    }
  }
}
```

### Any other client

Most other clients, such as Claude Desktop, Cursor, and LM Studio, read the same `mcpServers` format as Gemini CLI. Look up where your client keeps its MCP configuration, and add the entry there.

## Check the connection

1. Start PixInsight.

2. Ask the assistant:

   > Check the connection to PixInsight, and read the catalog of the processing library.

The assistant calls [`get_status`](../reference/tools.md#get_status), and then [`get_guide`](../reference/tools.md#get_guide) without a name. The catalog opens with the rules for working in PixInsight, so the assistant has them in every client.

## What the model needs

| Need | Why |
|---|---|
| Tool calling | Every step is a tool call. The server offers about 20 tools, whose descriptions take about 5,000 tokens. |
| Vision | The assistant judges an image by looking at previews. Without vision it can still measure with `get_image_stats`, but it cannot see halos, color casts, or artifacts. |
| A large context window | A whole workflow reads about a dozen guides and looks at dozens of previews. |
| Care with long tasks | A workflow has many steps, and each one is checked before the next. Small models tend to skip the checks. |

## What has been tested

| Client | Tested |
|---|---|
| Claude Code | Whole narrowband workflows on real data. |
| opencode 1.18 | The connection and the tool list. No processing run yet. |
| Codex CLI, Gemini CLI, and others | Not yet. The configuration above follows the documentation of each client. |

If you run the server with another client or model, please [report how it went](../../CONTRIBUTING.md#report-a-problem). That is how this table grows.

## Troubleshooting

**The assistant describes an image it cannot have seen, or says it got no picture.** Some clients do not hand pictures from a tool to the model. Every [`get_preview`](../reference/tools.md#get_preview) response also names the JPEG in `file`. Ask the assistant to open that file with the image or file tool of your client.

**The assistant does not follow the working rules.** The server sends them as its instructions, which not every client passes on. They are also at the top of the catalog. Ask the assistant to call `get_guide` without a name first.

**A tool call times out.** A tool waits at most 55 seconds, and then returns a [pending job](../reference/tools.md#pending-jobs) to check on. If your client gives up earlier, raise its tool timeout to at least 60 seconds.

**The client refuses the server or one of its tools.** Please report it, with the message of the client. The tool schemas use only the plain JSON Schema keywords that the common model providers accept, and a test keeps it that way.

## Next steps

- [Process your first image](../quickstart.md#step-3-start-pixinsight-and-check-the-connection)
- [Understand instances, jobs, and what keeps your work safe](../concepts.md)
