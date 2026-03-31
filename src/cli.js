'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const DEFAULT_API_BASE = 'https://api.assert.click';
const DEFAULT_WORK_DIR = path.join(os.tmpdir(), 'assert-runner');
const USER_AGENT = 'assert-cli/1.0';

function printUsage() {
  console.log(`Usage:
  assert run <file-or-dir> [...more paths] [--project <id>] [--api-url <url>] [--work-dir <path>]

Environment:
  ASSERT_API_KEY         Required API key
  ASSERT_API_URL         Optional API base URL (default: ${DEFAULT_API_BASE})
  ASSERT_WORK_DIR        Optional work directory (default: ${DEFAULT_WORK_DIR})
`);
}

function parseArgs(argv) {
  const raw = Array.isArray(argv) ? [...argv] : [];
  if (!raw.length || raw[0] === '--help' || raw[0] === '-h' || raw[0] === 'help') {
    return { help: true };
  }

  let command = raw[0];
  let args = raw.slice(1);
  if (command !== 'run') {
    command = 'run';
    args = raw;
  }

  const opts = {
    command,
    inputs: [],
    projectId: process.env.ASSERT_PROJECT_ID || null,
    apiBase: (process.env.ASSERT_API_URL || process.env.ASSERT_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, ''),
    workDir: process.env.ASSERT_WORK_DIR || DEFAULT_WORK_DIR,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--project' || arg === '--project-id') {
      opts.projectId = args[++i] || null;
      continue;
    }
    if (arg === '--api-url') {
      opts.apiBase = (args[++i] || opts.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
      continue;
    }
    if (arg === '--work-dir') {
      opts.workDir = args[++i] || opts.workDir;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }
    opts.inputs.push(arg);
  }

  return opts;
}

function normalizeDisplayPath(absPath) {
  const rel = path.relative(process.cwd(), absPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  return path.basename(absPath);
}

function collectMarkdownFiles(inputs) {
  const found = [];
  const seen = new Set();

  function walk(target) {
    const abs = path.resolve(target);
    if (seen.has(abs)) return;
    seen.add(abs);

    if (!fs.existsSync(abs)) {
      throw new Error(`Path not found: ${target}`);
    }

    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === '.git')) continue;
        walk(path.join(abs, entry.name));
      }
      return;
    }

    if (stat.isFile() && abs.toLowerCase().endsWith('.md')) {
      found.push({
        absPath: abs,
        relPath: normalizeDisplayPath(abs),
        content: fs.readFileSync(abs, 'utf8'),
      });
    }
  }

  for (const input of inputs) walk(input);
  found.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return found;
}

async function request(method, url, apiKey, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!res.ok) {
      const msg = parsed && typeof parsed === 'object'
        ? parsed.message || parsed.error || `HTTP ${res.status}`
        : `HTTP ${res.status}`;
      throw new Error(msg);
    }

    return parsed;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function ensureWorkDir(workDir) {
  const resolved = path.resolve(workDir);
  process.env.ASSERT_RUNNER_WORK_DIR = resolved;
  process.env.ASSERT_RUNS_DIR = path.join(resolved, 'runs');
  process.env.ASSERT_RUNTIME_DIR = path.join(resolved, 'runtime');
  process.env.MD_CACHE_DIR = path.join(process.env.ASSERT_RUNTIME_DIR, 'md-cache');
  fs.mkdirSync(process.env.ASSERT_RUNS_DIR, { recursive: true });
  fs.mkdirSync(process.env.MD_CACHE_DIR, { recursive: true });
  return resolved;
}

function buildLocalArtifactPath(workDir, runId, publicPath) {
  const prefix = `/runs/${runId}/`;
  const value = String(publicPath || '');
  if (!value.startsWith(prefix)) return null;
  const rel = value.slice(prefix.length);
  if (!rel) return null;
  return {
    relPath: rel,
    localPath: path.join(workDir, 'runs', runId, ...rel.split('/')),
  };
}

async function uploadArtifact(apiBase, apiKey, runId, relPath, content, encoding) {
  return request(
    'POST',
    `${apiBase}/v1/runs/${runId}/artifacts`,
    apiKey,
    {
      path: relPath,
      content,
      encoding,
    },
    30000
  );
}

async function uploadScreenshots(apiBase, apiKey, workDir, runId, results) {
  const uploaded = new Map();
  for (const scenario of results || []) {
    const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
    for (const step of steps) {
      if (!step || !step.screenshot) continue;
      const info = buildLocalArtifactPath(workDir, runId, step.screenshot);
      if (!info || !fs.existsSync(info.localPath)) {
        step.screenshot = null;
        continue;
      }
      if (!uploaded.has(info.relPath)) {
        try {
          const content = fs.readFileSync(info.localPath).toString('base64');
          const uploadedArtifact = await uploadArtifact(apiBase, apiKey, runId, info.relPath, content, 'base64');
          uploaded.set(info.relPath, uploadedArtifact.url || step.screenshot);
        } catch {
          uploaded.set(info.relPath, null);
        }
      }
      step.screenshot = uploaded.get(info.relPath);
    }
  }
  return results;
}

function runnerErrorResult(message) {
  return [{
    index: 1,
    scenario: 'Run failed',
    passed: false,
    steps: [{
      title: 'Runner error',
      status: 'fail',
      error: message,
    }],
  }];
}

function logEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'scenario:start') {
    process.stdout.write(`\n[assert] Scenario ${event.index}: ${event.scenario || ''}\n`);
    return;
  }
  if (event.type === 'step' && event.status === 'start') {
    process.stdout.write(`  > ${event.title || 'Step'}\n`);
    return;
  }
  if (event.type === 'step' && event.status === 'ok') {
    process.stdout.write(`    OK ${event.title || ''}\n`);
    return;
  }
  if (event.type === 'step' && event.status === 'fail') {
    process.stdout.write(`    FAIL ${event.title || ''}${event.error ? `: ${event.error}` : ''}\n`);
    return;
  }
}

async function runCommand(opts) {
  const apiKey = process.env.ASSERT_API_KEY;
  if (!apiKey) {
    throw new Error('ASSERT_API_KEY environment variable is required');
  }
  if (!opts.inputs.length) {
    throw new Error('At least one Markdown file or directory is required');
  }

  const mdFiles = collectMarkdownFiles(opts.inputs);
  if (!mdFiles.length) {
    throw new Error('No Markdown files found');
  }

  const workDir = ensureWorkDir(opts.workDir);
  const createBody = {
    totalFiles: mdFiles.length,
    source: 'cli',
  };
  if (opts.projectId) createBody.project_id = opts.projectId;

  const created = await request('POST', `${opts.apiBase}/v1/runs`, apiKey, createBody, 30000);
  const runId = created && (created.runId || created.run_id);
  if (!runId) {
    throw new Error('Service did not return a run ID');
  }

  console.log(`[assert] Created run ${runId}`);
  console.log(`[assert] Uploading ${mdFiles.length} Markdown file(s)`);
  for (const file of mdFiles) {
    await request('POST', `${opts.apiBase}/v1/runs/${runId}/files`, apiKey, {
      path: file.relPath,
      content: file.content,
    }, 30000);
  }

  const started = await request('POST', `${opts.apiBase}/v1/runs/${runId}/start`, apiKey, {}, 30000);
  const tests = Array.isArray(started && started.tests) ? started.tests : [];
  if (!tests.length) {
    throw new Error('Service did not return any prepared tests');
  }

  console.log(`[assert] Prepared ${tests.length} Playwright test(s)`);
  console.log(`[assert] Executing locally from ${workDir}`);

  let results;
  try {
    const { executePreparedTests } = require('./executor');
    results = await executePreparedTests(tests, runId, { workDir, onEvent: logEvent });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    try {
      await request('POST', `${opts.apiBase}/v1/runs/${runId}/results`, apiKey, {
        results: runnerErrorResult(message),
        passed: false,
      }, 30000);
    } catch (postErr) {
      console.warn(`[assert] Warning: failed to post runner error: ${postErr.message || postErr}`);
    }
    throw err;
  }

  try {
    await uploadScreenshots(opts.apiBase, apiKey, workDir, runId, results);
  } catch (err) {
    console.warn(`[assert] Warning: failed to upload screenshots: ${err.message || err}`);
  }
  const passed = results.every(result => result && result.passed !== false);
  await request('POST', `${opts.apiBase}/v1/runs/${runId}/results`, apiKey, { results, passed }, 30000);

  console.log(`\n[assert] Run ${runId} ${passed ? 'PASSED' : 'FAILED'}`);
  return passed ? 0 : 1;
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    printUsage();
    return 0;
  }

  if (opts.command !== 'run') {
    throw new Error(`Unknown command: ${opts.command}`);
  }

  return runCommand(opts);
}

module.exports = {
  main,
  parseArgs,
  collectMarkdownFiles,
  request,
  ensureWorkDir,
  uploadScreenshots,
  runnerErrorResult,
  logEvent,
};
