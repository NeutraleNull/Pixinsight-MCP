# Processing library format

This article describes the files of the processing library: where they go, what their front matter holds, and what the server checks. To add a method step by step, see [Add a processing method](../guides/add-a-processing-method.md).

## Layout

The library is the folder `processing` of this repository, plus the folders in [`PIXINSIGHT_MCP_GUIDE_DIRS`](configuration.md). The place of a file says what it is, and its path without `.md` is its ID.

| Path | Kind | Holds |
|---|---|---|
| `workflows/<name>.md` | Workflow | The order of stages for one kind of data |
| `stages/<name>.md` | Stage | What the stage is for, how to judge it, how to choose a method |
| `methods/<stage>/<name>.md` | Method | One technique: its steps, and how to check the result |
| `practices/<name>.md` | Practice | What applies to every task |

Names use lowercase letters, digits, and hyphens. Other files and folders, such as `README.md` and `templates`, are ignored.

A guide in a later folder replaces a guide with the same ID from an earlier one. The folder of the server comes first.

## Front matter

Every file starts with front matter between two lines of `---`. It takes two forms of values, and nothing else: `key: text` and `key: [a, b]`. Text can be in quotes. Lines that start with `#` are comments.

| Field | Form | Workflow | Stage | Method | Practice | Description |
|---|---|---|---|---|---|---|
| `title` | text | Required | Required | Required | Required | The heading the assistant sees. |
| `summary` | text | Required | Required | Required | Required | What it is and when to use it, in at most 160 characters. Shown in the catalog. |
| `status` | text | Required | – | Required | – | `tested` or `experimental`. |
| `evidence` | text | Required | – | Required | – | The runs this knowledge comes from. |
| `stages` | list | Required | – | – | – | The stages of the workflow, in order. |
| `requires` | list | – | – | Optional | – | Processes that must be installed. |
| `parameters` | list | – | – | Optional | – | Parameters the text names: `Process.parameter`, or `Process.parameter=Constant`. The process must be in `requires`. |
| `applies_to` | list | Optional | – | Optional | – | The kind of data. See below. |

A field that a kind does not use is an error, so that a misspelled field cannot go unnoticed.

### applies_to

| Value | Meaning |
|---|---|
| `narrowband`, `broadband` | The kind of filters |
| `mono`, `color` | One channel per image, or a color image |
| `linear`, `stretched` | Before or after the stretch |
| `starless`, `stars` | An image without stars, or a star image |

## Text

| Rule | Applies to |
|---|---|
| No top heading (`# …`): the `title` becomes it | All |
| At most 80 lines, or 120 for a workflow | All |
| The headings `## Steps` and `## Check the result` | Methods |
| An ID in backticks, such as `` `stages/stretch` ``, must exist | All |
| Every stage in `stages` exists, and the text mentions it as `` `stages/<name>` `` | Workflows |
| The stage of a method has a file in `stages` | Methods |

## What the server makes of it

[`get_guide`](tools.md#get_guide) reads the files on every call.

| Request | Response |
|---|---|
| No name | The catalog: every guide with its ID and summary, methods below their stage |
| A workflow or a practice | Its title, summary, and text |
| A stage | Its text, and the list of its methods. If it has one method, that method in full |
| A method | Its title, summary, stage, needs, status, and evidence, and then its text |

The server matches the library to the running PixInsight:

- **Missing processes:** a method whose `requires` names a process that is not installed is marked `Not installed here`.
- **Changed parameters:** if the installed version of a process has no parameter or constant that `parameters` names, the method starts with a warning.
- **No answer:** if PixInsight does not answer within a few seconds, the guides come without this check, and the catalog says so.

A file with a mistake is left out. The catalog lists it under **Files with problems**, with the reason.

## Check a library

| Command | Checks | Needs PixInsight |
|---|---|---|
| `npm run guides:check` | Everything on this page, for the library of the server | No |
| `npm run guides:check -- <folder>` | The same, with a folder of your own added | No |
| `npm test` | The same, as part of the unit tests | No |
| `npm run test:live` | Also every name in `parameters`, against the installed processes | Yes |
