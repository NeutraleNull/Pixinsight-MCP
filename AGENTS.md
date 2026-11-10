# PixInsight MCP

These instructions are for every coding assistant and every person working on this repository.

MCP server (TypeScript, Node >= 20) that controls PixInsight only through its documented command line.
The design and the roadmap are in `docs/architecture.md`, and every measured PixInsight behaviour is in
`docs/reference/pixinsight-behaviour.md`: read both before changing how the server talks to PixInsight.
User documentation is the rest of `docs/`.

## Commands

- `npm run build`, `npm run typecheck`
- `npm test`: unit tests, no PixInsight needed
- `npm run guides:check`: checks the processing library and prints its catalog
- `npm run test:live`: against a real, windowless PixInsight on slots 230 to 239; builds first. Set
  `PIXINSIGHT_TEST_SOLVED_IMAGE` to a plate-solved master to also test real metadata.
- `node scripts/check-start.mjs`: starts the built server as a client would, without PixInsight
- `node scripts/smoke.mjs`: as an MCP client against a running instance that the user can watch

CI (`.github/workflows/ci.yml`) runs everything that needs no PixInsight, on Linux, Windows and macOS. A version tag starts the release workflow: see `CONTRIBUTING.md`.

## Hard rules

- **Licensing:** never copy PixInsight or PCL sources or documentation into this repository, and never
  `#include` them. Never run `strings` or similar on PixInsight binaries: the EULA forbids reverse
  engineering. Use `PixInsight --help` and the docs in the installation directory.
- **The user's instance is sacred.** Never send it `--terminate`, never kill it, and never start a test
  against it without asking. Automated tests use their own windowless slots.
- **Tests touching PixInsight must clean up:** own instances stopped, `core-<slot>-pxi.settings` of test
  slots removed.
- **Follow the rules for the user's instance** in `docs/architecture.md`: always with history, no
  default `close()` or `saveAs()`, no numbers for enum parameters.
- **Every new PixInsight behaviour we depend on gets a live test,** so that updates reveal breakage, and
  a row in `docs/reference/pixinsight-behaviour.md`, in our own words.
- **Tests check real effects.** Test images are not square, and results are verified in the output, such as
  the size stored in a JPEG, rather than in what a tool reports about itself. A test waits for a state,
  never for a fixed time: CI runs them on slow machines.
- **Examples in the docs come from real runs.** Check parameter names and responses against PixInsight.

## Conventions

- `pjsr/` runs inside PixInsight's V8: own code only, with a `#engine v8` directive on entry scripts and
  no includes. Operations in `pjsr/ops/` are function bodies receiving `args` and `ctx`; report problems
  with `ctx.fail( kind, message )`.
- All platform differences go into `src/platform.ts`, all executable calls into `src/bridge/cli.ts`.
- stdout belongs to the MCP protocol: log to stderr only.
- Tool problems are results with `isError`, written so that the model can act on them.
- The server serves any MCP client and any model. Tool schemas stay within the keywords that
  `test/unit/tools.test.ts` allows, and nothing in a tool, a result or a guide depends on one assistant.
- The project is under GPL-3.0-or-later. A new dependency needs a license that is compatible with it.
- The maintainer writes German; code, comments and docs are in English.

## Documentation layers

Each layer has its own reader and cost. Do not repeat a fact in two layers: point to it.

| Layer | Where | Reader | Loaded |
|---|---|---|---|
| Human docs | `README.md`, `docs/` except the two developer documents | People | Never by the assistant, unless it opens them |
| Standing rules | `rules` in `src/tools.ts` | The assistant | In every session, as the instructions of the server, so under 2,048 characters, and only what applies always. The catalog of `get_guide` repeats them, because not every client passes instructions on |
| Tool descriptions | `src/tools.ts` | The assistant | In every session, so one or two sentences per tool |
| Processing library | `processing/` | The assistant | On demand, through `get_guide`. Workflows, stages, methods and practices, one small file each |
| Entry skill | `skills/pixinsight-processing/SKILL.md` | The assistant in Claude Code | Its description always, its text on demand. It only points to `get_guide` |
| Developer docs | `AGENTS.md`, `docs/architecture.md`, `docs/reference/pixinsight-behaviour.md` | Contributors and their coding assistants | When working on this repository. `CLAUDE.md` only imports `AGENTS.md` |

A guide needs no code and no registration: the server finds the files in `processing/`, and `npm test` checks them. The format is in `docs/reference/processing-library.md`. Processing knowledge goes there, and nowhere else.

## Documentation style

User documentation follows Stripe and Microsoft Learn. Guides in `processing/` are written for an assistant: imperative, short, with evidence for every claim that came from one run, and a way to check the result.

- One article type per file: quickstart, concept, how-to guide, or reference. Name it after the task.
- Open with what the reader can do or learn. Address the reader directly, in the present tense, with short
  sentences and imperative steps.
- How-to articles have prerequisites, numbered steps, and next steps. Callouts use `[!NOTE]`, `[!TIP]`,
  `[!IMPORTANT]`, or `[!WARNING]`, and only when a reader could otherwise lose work or time.
- Reference articles show every parameter in a table, with a real example response. Each error gets a stable
  code, its meaning, and what to do about it.
