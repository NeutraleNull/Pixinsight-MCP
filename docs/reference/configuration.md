# Configuration reference

The server is configured through environment variables. All of them are optional.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PIXINSIGHT_EXECUTABLE` | [Standard path](#standard-paths) | The PixInsight executable. On Linux, this is the `PixInsight.sh` launcher. |
| `PIXINSIGHT_SLOT` | First running instance | The slot of the instance to work with in shared mode, from 1 to 256. It must not be one of the [shadow slots](../concepts.md#instances). |
| `PIXINSIGHT_MCP_MODE` | `shared` | `shared` works with an instance you started. `worker` uses an own instance. See [Shared mode and worker mode](../concepts.md#shared-mode-and-worker-mode). |
| `PIXINSIGHT_MCP_WORKER_SLOT` | `200` | The slot of the own instance in worker mode. It must not be one of the [shadow slots](../concepts.md#instances). |
| `PIXINSIGHT_MCP_SHADOW_SLOT` | `250` | The first of up to seven slots for the instances that try risky settings. Each running server uses the first one that is free. |
| `PIXINSIGHT_MCP_ALLOWED_PROGRAMS` | None | The programs that processes may be told to run, separated by `:`, or by `;` on Windows. For example the GraXpert program, for the `appPath` parameter of the `GraXpert` process. |
| `PIXINSIGHT_MCP_GUIDE_DIRS` | None | Folders with guides of your own, separated by `:`, or by `;` on Windows. They add to the [processing library](processing-library.md), and replace guides with the same ID. |
| `PIXINSIGHT_MCP_SCRIPT_DIRS` | None | Folders with scripts the assistant may start, besides those PixInsight ships, as absolute paths separated by `:`, or by `;` on Windows. The server reads them when it starts. See [Use scripts from your own folders](../guides/run-scripts-and-code.md#use-scripts-from-your-own-folders). |
| `PIXINSIGHT_MCP_ALLOW_CODE` | `0` | `1` lets the assistant run code of its own inside PixInsight. Such code can do anything a script can. See [Let the assistant run its own code](../guides/run-scripts-and-code.md#let-the-assistant-run-its-own-code). |
| `PIXINSIGHT_MCP_HEADLESS` | `1` on Linux, otherwise `0` | `1` runs own instances without a window. It relies on the Qt `offscreen` plugin, which is verified on Linux only. |
| `PIXINSIGHT_MCP_HOME` | [Per-user folder](#files-the-server-creates) | The folder for job files. Its path must not contain `,` `"` `'` `` ` `` `$` `;` `&` `\|` `<` `>` `(` `)` `[` `]` `{` `}` `*` `?` or a tab. |

To set a variable for one server, add it to the MCP configuration of your client:

```json
{
  "mcpServers": {
    "pixinsight": {
      "command": "node",
      "args": ["/absolute/path/to/PixInsightMCP/dist/index.js"],
      "env": { "PIXINSIGHT_SLOT": "2" }
    }
  }
}
```

## Standard paths

| Platform | PixInsight executable | Verified |
|---|---|---|
| Linux | `/opt/PixInsight/bin/PixInsight.sh` | Yes |
| macOS | `/Applications/PixInsight/PixInsight.app/Contents/MacOS/PixInsight` | No |
| Windows | `C:\Program Files\PixInsight\bin\PixInsight.exe` | No |

## Files the server creates

| Location | Content |
|---|---|
| `~/.local/state/mcp-server-for-pixinsight` on Linux | Job files, the PJSR scripts per version, which server owns which slot in `leases`, and the remembered verdicts in `enum-checks.json` |
| `~/Library/Application Support/mcp-server-for-pixinsight` on macOS | The same |
| `%LOCALAPPDATA%\mcp-server-for-pixinsight` on Windows | The same |
| `~/.PixInsight/core-<slot>-pxi.settings` | Created by PixInsight for each slot it runs on, including the shadow and worker slots |

The server removes job files of finished jobs after the 100 most recent, and everything older than a day when it starts. Script versions go a week after a server last started with them. Several servers can share this folder.

`save_image` and `export_image` can leave two kinds of files next to a target if PixInsight crashes while it writes: `<name>.mcp-backup`, which is the old file, and `<name>.mcp-tmp.<ext>`, which is an unfinished new one.

The server does not write to the PixInsight installation, and does not change your settings or preferences.
