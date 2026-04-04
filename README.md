# @assert-click/runner

CLI package for running Assert tests from your own machine or CI.

It provides two executables:

- `assert`
- `assert-runner`

## Requirements

- Node.js `>=18`
- A project-scoped Assert key, either stored in `assert.config.json` or provided via `ASSERT_API_KEY`

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

Then run from the repo root:

```bash
assert
```

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

`workDir` is the local scratch directory used while running tests. Assert stores failure screenshots and runtime scratch files there during execution. By default, per-run folders are deleted after results and screenshots are uploaded. Set `ASSERT_KEEP_LOCAL_ARTIFACTS=true` or `keepLocalArtifacts: true` only if you want to inspect local artifacts after a run.

`input` can be:

- a single file path
- a folder path
- a glob pattern such as `tests/**/*.assert.md`
- an array mixing all of the above

`assert.config.local.json` is the place for local-only overrides such as a different local key or other machine-specific settings.

## Input format

`assert run` expects Markdown scenario files. Example:

```markdown
URL: https://example.com/login
SCENARIO: User logs in
PROCESS:
  - Fill "email" with "user@example.com"
  - Fill "password" with "secret"
  - Click "Sign in"
EXPECT: Dashboard
```

## License

MIT
