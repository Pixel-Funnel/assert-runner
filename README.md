# @assert-click/runner

Run your [Assert](https://assert.click) E2E scenarios locally or in CI. Write tests in plain Markdown — Assert generates the Playwright execution, this runner executes it and sends results back to your dashboard.

**[Sign up free at assert.click](https://assert.click)** to get your API key and project ID before using this package.

## How it works

1. You write scenarios in plain-English Markdown (`.assert.md` files)
2. `assert run` uploads them to Assert, which generates and prepares Playwright tests
3. The runner executes the tests locally in a real Chromium browser
4. Results and failure screenshots are sent back to your [Assert dashboard](https://assert.click)

## Requirements

- Node.js `>=18`
- A project-scoped Assert key — get one at [assert.click](https://assert.click)

## Install

```bash
npm install -g @assert-click/runner
```

## Quick start

Create `assert.config.json` in your repo:

```json
{
  "projectApiKey": "assert_project_key_here",
  "projectId": "project_123",
  "input": ["tests/**/*.assert.md"]
}
```

Write a scenario in `tests/login.assert.md`:

```markdown
URL: https://example.com/login
SCENARIO: User logs in
PROCESS:
  - Fill "email" with "user@example.com"
  - Fill "password" with "secret"
  - Click "Sign in"
EXPECT: Dashboard
```

Then run from your repo root:

```bash
assert
```

Results appear in your [Assert dashboard](https://assert.click) with step-level pass/fail and failure screenshots.

## Commands

### `assert run`

Upload local Markdown scenario files to Assert, execute the prepared tests locally, and send results back to the service.

```bash
assert run
```

You can also run without passing paths if `assert.config.json` defines `input`:

```bash
assert
```

Arguments:

- One or more Markdown files, directories, or glob patterns

Options:

- `--project <id>`
- `--work-dir <path>`
- `--config <path>`

Environment variables:

- `ASSERT_API_KEY`: preferred API key env var
- `ASSERT_WORK_DIR`: optional, defaults to a temp directory
- `ASSERT_KEEP_LOCAL_ARTIFACTS`: optional, keeps local per-run files after upload for debugging
- `ASSERT_PROJECT_ID`: optional default project ID
- `ASSERT_CONFIG`: optional path to a config file or directory

Exit code:

- `0` if all scenarios passed
- `1` if any scenario failed or the run could not be completed

### `assert-runner`

Poll Assert for prepared jobs, execute them locally, and post results back.
This is for organisations using the self-hosted runner queue. For ad hoc local runs, use `assert run`.

```bash
ASSERT_API_KEY=your_key_here assert-runner
```

Options:

- `--config <path>`

Environment variables:

- `ASSERT_API_KEY`: preferred API key env var
- `ASSERT_WORK_DIR`: optional, defaults to a temp directory
- `ASSERT_KEEP_LOCAL_ARTIFACTS`: optional, keeps local per-run files after upload for debugging
- `ASSERT_POLL_INTERVAL_MS`: optional, defaults to `5000`
- `ASSERT_IDLE_LOG_INTERVAL_MS`: optional, defaults to `60000`
- `ASSERT_CONFIG`: optional path to a config file or directory

## Config files

The runner will look for these files from the current directory upward:

- `assert.config.json`
- `assert.config.local.json`

`assert.config.local.json` is merged on top of `assert.config.json`.

Recommended setup:

- Commit `assert.config.json`
- Add `assert.config.local.json` to `.gitignore`
- Use a dedicated project-scoped key if you commit one to the repo

Example:

```json
{
  "projectApiKey": "assert_project_key_here",
  "projectId": "project_123",
  "input": ["tests/**/*.assert.md", "smoke/login.assert.md"],
  "workDir": ".assert",
  "keepLocalArtifacts": false,
  "show_browser": false,
  "run_only_failed": false,
  "runner": {
    "pollIntervalMs": 5000,
    "idleLogIntervalMs": 60000,
    "keepLocalArtifacts": false
  }
}
```

If you prefer env-based secrets instead of committing the key:

```json
{
  "projectApiKeyEnv": "ASSERT_API_KEY",
  "projectId": "project_123"
}
```

`show_browser` opens a visible Chromium window so you can watch tests execute in real time. Defaults to `false` (headless). Not recommended for CI — use it locally when debugging a failing scenario.

`run_only_failed` re-runs only the scenarios that failed in the previous run. After each run the runner writes a `.assert-last-run.json` cache file next to `assert.config.json` recording which files failed. On the next run, only those files are submitted. If the cache does not exist or there were no failures, all tests run as normal. You may want to add `.assert-last-run.json` to `.gitignore`. Defaults to `false`.

`workDir` is the local scratch directory used while running tests. Assert stores failure screenshots and runtime scratch files there during execution. By default, per-run folders are deleted after results and screenshots are uploaded. Set `ASSERT_KEEP_LOCAL_ARTIFACTS=true` or `keepLocalArtifacts: true` only if you want to inspect local artifacts after a run.

`input` can be:

- a single file path
- a folder path
- a glob pattern such as `tests/**/*.assert.md`
- an array mixing all of the above

`assert.config.local.json` is the place for local-only overrides such as a different local key or other machine-specific settings.

## CI integration

Add Assert to your CI pipeline by running `assert` as a step. Set `ASSERT_API_KEY` as a secret environment variable in your CI provider.

Example GitHub Actions step:

```yaml
- name: Run Assert E2E tests
  run: npx @assert-click/runner
  env:
    ASSERT_API_KEY: ${{ secrets.ASSERT_API_KEY }}
```

## License

MIT
