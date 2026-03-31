'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const { resolveCliConfig, CONFIG_FILE, LOCAL_CONFIG_FILE } = require('./config');

dotenv.config();

const DEFAULT_API_BASE = 'https://api.assert.click';
const DEFAULT_WORK_DIR = path.join(os.tmpdir(), 'assert-runner');
const USER_AGENT = 'assert-cli/1.0';

function printUsage() {
  console.log(`Usage:
  assert run [file-dir-or-glob ...more paths] [--project <id>] [--work-dir <path>] [--config <path>]
  assert [file-dir-or-glob ...more paths]

Environment:
  ASSERT_API_KEY         Preferred API key env var
  ASSERT_WORK_DIR        Optional work directory (default: ${DEFAULT_WORK_DIR})

Config files:
  ${CONFIG_FILE}         Shared project config, discovered from the current directory upward
  ${LOCAL_CONFIG_FILE}   Local override file, merged on top when present
`);
}

function parseArgs(argv) {
  const raw = Array.isArray(argv) ? [...argv] : [];
  if (raw[0] === '--help' || raw[0] === '-h' || raw[0] === 'help') {
    return { help: true };
  }

  let command = 'run';
  let args = raw;
  if (raw[0] === 'run') {
    args = raw.slice(1);
  }

  const opts = {
    command,
    inputs: [],
    configPath: process.env.ASSERT_CONFIG || null,
    projectId: null,
    apiBase: null,
    workDir: null,
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
    if (arg === '--config') {
      opts.configPath = args[++i] || opts.configPath;
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

function hasGlobMagic(value) {
  return /[*?\[]/.test(String(value || ''));
}

function segmentToRegex(segment) {
  const escaped = String(segment || '')
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

function matchGlobSegments(patternSegments, fileSegments, pIndex = 0, fIndex = 0) {
  if (pIndex === patternSegments.length) return fIndex === fileSegments.length;

  const pattern = patternSegments[pIndex];
  if (pattern === '**') {
    if (pIndex === patternSegments.length - 1) return true;
    for (let i = fIndex; i <= fileSegments.length; i++) {
      if (matchGlobSegments(patternSegments, fileSegments, pIndex + 1, i)) return true;
    }
    return false;
  }

  if (fIndex >= fileSegments.length) return false;
  return segmentToRegex(pattern).test(fileSegments[fIndex]) &&
    matchGlobSegments(patternSegments, fileSegments, pIndex + 1, fIndex + 1);
}

function expandGlob(pattern) {
  const absolutePattern = path.resolve(pattern);
  const absoluteSegments = absolutePattern.split(path.sep).filter(Boolean);
  const firstMagicIndex = absoluteSegments.findIndex((segment) => hasGlobMagic(segment) || segment === '**');
  const baseSegments = firstMagicIndex === -1 ? absoluteSegments : absoluteSegments.slice(0, firstMagicIndex);
  const baseDir = path.isAbsolute(absolutePattern)
    ? path.join(path.sep, ...baseSegments)
    : path.resolve(...baseSegments);
  const patternSegments = absoluteSegments.slice(firstMagicIndex === -1 ? absoluteSegments.length : firstMagicIndex);
  const found = [];

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === '.git')) continue;
      const abs = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativeSegments = path.relative(baseDir, abs).split(path.sep).filter(Boolean);
      if (matchGlobSegments(patternSegments, relativeSegments)) {
        found.push(abs);
      }
    }
  }

  if (fs.existsSync(baseDir) && fs.statSync(baseDir).isDirectory()) {
    walk(baseDir);
  }
  return found;
}

function collectMarkdownFiles(inputs) {
  const found = [];
  const seen = new Set();

  function addFile(abs) {
    if (!abs.toLowerCase().endsWith('.md')) return;
    found.push({
      absPath: abs,
      relPath: normalizeDisplayPath(abs),
      content: fs.readFileSync(abs, 'utf8'),
    });
  }

  function walkExisting(absPath) {
    const resolved = path.resolve(absPath);
    if (seen.has(resolved)) return;
    seen.add(resolved);

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
        if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === '.git')) continue;
        walkExisting(path.join(resolved, entry.name));
      }
      return;
    }

    if (stat.isFile()) {
      addFile(resolved);
    }
  }

  function walk(target) {
    const abs = path.resolve(target);
    if (fs.existsSync(abs)) {
      walkExisting(abs);
      return;
    }
    if (hasGlobMagic(target)) {
      const matches = expandGlob(target);
      if (!matches.length) {
        throw new Error(`No files matched pattern: ${target}`);
      }
      for (const match of matches) {
        walkExisting(match);
      }
      return;
    }
    throw new Error(`Path not found: ${target}`);
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

function toAbsoluteUrl(baseUrl, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).toString();
  } catch {}
  try {
    return new URL(raw, `${String(baseUrl || '').replace(/\/$/, '')}/`).toString();
  } catch {}
  return raw;
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
  const failures = [];
  for (const scenario of results || []) {
    const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
    for (const step of steps) {
      if (!step || !step.screenshot) continue;
      const info = buildLocalArtifactPath(workDir, runId, step.screenshot);
      if (!info || !fs.existsSync(info.localPath)) {
        failures.push(`${step.title || 'Step'}: local screenshot file missing`);
        step.screenshot = null;
        continue;
      }
      if (!uploaded.has(info.relPath)) {
        try {
          const content = fs.readFileSync(info.localPath).toString('base64');
          const uploadedArtifact = await uploadArtifact(apiBase, apiKey, runId, info.relPath, content, 'base64');
          uploaded.set(info.relPath, toAbsoluteUrl(apiBase, uploadedArtifact.url || step.screenshot));
        } catch (err) {
          failures.push(`${step.title || 'Step'}: ${err?.message || String(err)}`);
          uploaded.set(info.relPath, null);
        }
      }
      step.screenshot = uploaded.get(info.relPath);
    }
  }
  if (failures.length) {
    throw new Error(`Failed to upload ${failures.length} screenshot artifact${failures.length === 1 ? '' : 's'}: ${failures[0]}`);
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

function formatStructuredBlock(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value || '');
  }
}

function logEvent(event) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'auth:start') {
    process.stdout.write(`[assert] Auth: signing in${event.url ? ` at ${event.url}` : ''}\n`);
    return;
  }
  if (event.type === 'auth:redirect') {
    process.stdout.write(`[assert] Auth: login required${event.targetUrl ? ` for ${event.targetUrl}` : ''}\n`);
    return;
  }
  if (event.type === 'auth:complete') {
    process.stdout.write(`[assert] Auth: session ready\n`);
    return;
  }
  if (event.type === 'auth:error') {
    process.stdout.write(`[assert] Auth: failed${event.message ? `: ${event.message}` : ''}\n`);
    if (event.details) {
      process.stdout.write(`${formatStructuredBlock(event.details)}\n`);
    }
    return;
  }
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

function truncateText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildProgressBar(completed, total) {
  const safeTotal = Math.max(Number(total) || 0, 1);
  const width = Math.max(10, Math.min(24, Math.floor((process.stdout.columns || 80) / 4)));
  const ratio = Math.max(0, Math.min(1, completed / safeTotal));
  const filled = Math.round(width * ratio);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

function createRunReporter({ prefix = 'assert' } = {}) {
  const interactive = Boolean(process.stdout.isTTY);
  const useColor = interactive && !Object.prototype.hasOwnProperty.call(process.env, 'NO_COLOR');
  const spinnerFrames = ['-', '\\', '|', '/'];
  const state = {
    totalScenarios: 0,
    completedScenarios: 0,
    finishedSteps: 0,
    failedSteps: 0,
    currentScenarioIndex: 0,
    currentScenario: '',
    currentScenarioError: '',
    currentStep: '',
    spinnerIndex: 0,
    spinnerTimer: null,
    stopped: false,
  };

  function color(code, text) {
    if (!useColor) return text;
    return `\x1b[${code}m${text}\x1b[0m`;
  }

  function clearStatusLine() {
    if (!interactive) return;
    process.stdout.write('\r\x1b[2K');
  }

  function writeLine(line) {
    if (interactive) {
      clearStatusLine();
      process.stdout.write(`${line}\n`);
      render();
      return;
    }
    process.stdout.write(`${line}\n`);
  }

  function totalLabel() {
    return state.totalScenarios > 0 ? String(state.totalScenarios) : '?';
  }

  function activeLabel() {
    if (state.currentStep) return `Running: ${truncateText(state.currentStep, 56)}`;
    if (state.currentScenario) return `Scenario: ${truncateText(state.currentScenario, 56)}`;
    return 'Waiting for next update';
  }

  function statusLine() {
    const spinner = state.currentStep ? spinnerFrames[state.spinnerIndex % spinnerFrames.length] : '=';
    const bar = buildProgressBar(state.completedScenarios, state.totalScenarios || 1);
    const stepSummary = `${state.finishedSteps} step${state.finishedSteps === 1 ? '' : 's'}${state.failedSteps ? `, ${state.failedSteps} failed` : ''}`;
    return `[${prefix}] ${spinner} ${bar} ${state.completedScenarios}/${totalLabel()} scenarios | ${stepSummary} | ${activeLabel()}`;
  }

  function render() {
    if (!interactive || state.stopped) return;
    clearStatusLine();
    process.stdout.write(statusLine());
  }

  function startSpinner() {
    if (!interactive || state.spinnerTimer || state.stopped) return;
    state.spinnerTimer = setInterval(() => {
      state.spinnerIndex = (state.spinnerIndex + 1) % spinnerFrames.length;
      render();
    }, 80);
    if (typeof state.spinnerTimer.unref === 'function') {
      state.spinnerTimer.unref();
    }
  }

  function stopSpinner() {
    if (!state.spinnerTimer) return;
    clearInterval(state.spinnerTimer);
    state.spinnerTimer = null;
  }

  function handleInteractiveEvent(event) {
    if (event.type === 'auth:start') {
      writeLine(`[${prefix}] Auth: signing in${event.url ? ` at ${event.url}` : ''}`);
      return;
    }

    if (event.type === 'auth:redirect') {
      writeLine(`[${prefix}] Auth: login required${event.targetUrl ? ` for ${event.targetUrl}` : ''}`);
      return;
    }

    if (event.type === 'auth:complete') {
      writeLine(`[${prefix}] Auth: session ready`);
      return;
    }

    if (event.type === 'auth:error') {
      writeLine(`[${prefix}] Auth: failed${event.message ? `: ${truncateText(event.message, 180)}` : ''}`);
      if (event.details) {
        writeLine(formatStructuredBlock(event.details));
      }
      return;
    }

    if (event.type === 'run:start') {
      state.totalScenarios = Number(event.totalScenarios) || state.totalScenarios;
      writeLine(`[${prefix}] Prepared ${state.totalScenarios || '?'} scenario${state.totalScenarios === 1 ? '' : 's'} for execution`);
      return;
    }

    if (event.type === 'scenario:start') {
      state.currentScenarioIndex = Number(event.index) || (state.completedScenarios + 1);
      state.totalScenarios = Math.max(state.totalScenarios, state.currentScenarioIndex);
      state.currentScenario = String(event.scenario || `Scenario ${state.currentScenarioIndex}`);
      state.currentScenarioError = '';
      state.currentStep = '';
      writeLine(`[${prefix}] Scenario ${state.currentScenarioIndex}/${totalLabel()}: ${state.currentScenario}`);
      return;
    }

    if (event.type === 'step' && event.status === 'start') {
      state.currentStep = String(event.title || 'Step');
      startSpinner();
      render();
      return;
    }

    if (event.type === 'step' && event.status === 'ok') {
      state.finishedSteps += 1;
      state.currentStep = '';
      stopSpinner();
      render();
      return;
    }

    if (event.type === 'step' && event.status === 'fail') {
      state.finishedSteps += 1;
      state.failedSteps += 1;
      state.currentScenarioError = event.error ? String(event.error) : '';
      state.currentStep = '';
      stopSpinner();
      writeLine(`[${prefix}] ${color('31', 'FAIL')} ${event.title || 'Step'}${state.currentScenarioError ? `: ${truncateText(state.currentScenarioError, 180)}` : ''}`);
      return;
    }

    if (event.type === 'scenario:complete') {
      state.completedScenarios = Math.max(state.completedScenarios, Number(event.index) || state.completedScenarios + 1);
      stopSpinner();
      state.currentStep = '';
      const scenarioName = String(event.scenario || state.currentScenario || `Scenario ${state.completedScenarios}`);
      const status = event.passed === false ? color('31', 'FAIL') : color('32', 'PASS');
      const detail = event.passed === false && state.currentScenarioError
        ? `: ${truncateText(state.currentScenarioError, 180)}`
        : '';
      state.currentScenario = '';
      writeLine(`[${prefix}] ${status} ${state.completedScenarios}/${totalLabel()} ${scenarioName}${detail}`);
      state.currentScenarioError = '';
    }
  }

  return {
    event(event) {
      if (!event || typeof event !== 'object') return;
      if (!interactive) {
        logEvent(event);
        return;
      }
      handleInteractiveEvent(event);
    },
    info(message) {
      writeLine(`[${prefix}] ${message}`);
    },
    warn(message) {
      writeLine(`[${prefix}] Warning: ${message}`);
    },
    error(message) {
      writeLine(`[${prefix}] ${message}`);
    },
    stop() {
      state.stopped = true;
      stopSpinner();
      clearStatusLine();
    },
  };
}

async function runCommand(opts) {
  const apiKey = opts.apiKey;
  if (!apiKey) {
    throw new Error('Assert API key is required. Set ASSERT_API_KEY, configure projectApiKeyEnv, or store projectApiKey in assert.config.json');
  }
  if (!opts.inputs.length) {
    throw new Error('At least one Markdown file, directory, or glob pattern is required. Pass a path, or set input in assert.config.json');
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
  const auth = started && typeof started.auth === 'object' ? started.auth : null;
  if (!tests.length) {
    throw new Error('Service did not return any prepared tests');
  }

  const reporter = createRunReporter({ prefix: 'assert' });
  reporter.info(`Prepared ${tests.length} Playwright test file${tests.length === 1 ? '' : 's'}`);
  reporter.info(`Executing locally from ${workDir}`);

  let results;
  try {
    const { executePreparedTests } = require('./executor');
    results = await executePreparedTests(tests, runId, { workDir, onEvent: reporter.event, auth });
  } catch (err) {
    reporter.stop();
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
  reporter.stop();

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
  const rawOpts = parseArgs(argv);
  if (rawOpts.help) {
    printUsage();
    return 0;
  }

  if (rawOpts.command !== 'run') {
    throw new Error(`Unknown command: ${rawOpts.command}`);
  }

  const opts = resolveCliConfig(rawOpts, {
    cwd: process.cwd(),
    env: process.env,
    apiBase: DEFAULT_API_BASE,
    workDir: DEFAULT_WORK_DIR,
  });
  return runCommand(opts);
}

module.exports = {
  main,
  parseArgs,
  collectMarkdownFiles,
  request,
  ensureWorkDir,
  toAbsoluteUrl,
  uploadScreenshots,
  runnerErrorResult,
  logEvent,
  createRunReporter,
};
