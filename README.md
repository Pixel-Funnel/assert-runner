# @assert-click/runner

CLI package for running Assert tests from your own machine or CI.

It provides two executables:

- `assert`
- `assert-runner`

## Requirements

- Node.js `>=18`
- An Assert API key in `ASSERT_API_KEY`

## Install

```bash
npm install -g @assert-click/runner
```

## Commands

### `assert run`

Upload local Markdown scenario files to Assert, execute the prepared tests locally, and send results back to the service.

```bash
ASSERT_API_KEY=your_key_here assert run ./tests/
```

Arguments:

- One or more `.md` files or directories

Options:

- `--project <id>`
- `--api-url <url>`
- `--work-dir <path>`

Environment variables:

- `ASSERT_API_KEY`: required
- `ASSERT_API_URL`: optional, defaults to `https://api.assert.click`
- `ASSERT_WORK_DIR`: optional, defaults to a temp directory
- `ASSERT_PROJECT_ID`: optional default project ID

Exit code:

- `0` if all scenarios passed
- `1` if any scenario failed or the run could not be completed

### `assert-runner`

Poll Assert for prepared jobs, execute them locally, and post results back.

```bash
ASSERT_API_KEY=your_key_here assert-runner
```

Environment variables:

- `ASSERT_API_KEY`: required
- `ASSERT_API_URL`: optional, defaults to `https://api.assert.click`
- `ASSERT_WORK_DIR`: optional, defaults to a temp directory
- `ASSERT_POLL_INTERVAL_MS`: optional, defaults to `5000`

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
