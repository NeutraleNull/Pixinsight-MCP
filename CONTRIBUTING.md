# Contribute to the MCP server for PixInsight

Contributions are welcome: a processing method you have tried, a fix, a test on Windows or macOS, or a report of what went wrong in a session.

## Add a processing method

A method is one Markdown file, and needs no code. Follow [Add a processing method](docs/guides/add-a-processing-method.md), and run:

```bash
npm run guides:check
```

Write from a real run, say how to check the result, and use your own words.

## Change the server

1. Read [the architecture](docs/architecture.md) for the design, and the [PixInsight behaviour reference](docs/reference/pixinsight-behaviour.md) for every measured behaviour the server relies on.
2. Read [AGENTS.md](AGENTS.md). Its rules apply to people and to coding assistants alike.
3. Run the checks:

   ```bash
   npm run typecheck
   ```

   ```bash
   npm test
   ```

4. If your change touches how the server talks to PixInsight, also run the live tests. They start their own windowless PixInsight on slots 230 to 239, and leave your own instance alone:

   ```bash
   npm run test:live
   ```

> [!IMPORTANT]
> Never add PixInsight or PCL source code or documentation to this repository, not even as an excerpt in a test or a guide. Their licenses do not allow it. Describe behaviour in your own words, from what you measured.

## Make a release

For maintainers. A release is made by a version tag, not by every push to `main`: a release needs a version and a moment someone chose, and `main` should be free to move in between.

1. Make sure `main` is green in CI.
2. Set the new version, which also updates the plugin manifest, and creates the commit and the tag:

   ```bash
   npm version minor
   ```

3. Push both:

   ```bash
   git push --follow-tags
   ```

The [release workflow](.github/workflows/release.yml) then runs the tests on Linux, Windows, and macOS, builds the package, installs it in an empty folder, starts the server from there, and publishes a GitHub release with the package file and generated notes. A tag with a suffix, such as `v0.2.0-beta.1`, becomes a pre-release.

CI runs without PixInsight, because its license cannot go into public CI. Run `npm run test:live` on your own machine before you tag.

## Report a problem

Open an issue with the PixInsight version, your operating system, the tool call and its full response. An error response carries a stable code, which the [error reference](docs/reference/errors.md) explains.

## License of contributions

This project is under the [GNU General Public License](LICENSE), version 3 or any later version. By contributing, you agree that your contribution is published under the same license, and you confirm that you have the right to contribute it.
