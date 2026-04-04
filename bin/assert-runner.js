#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const { executePreparedTests } = require('../src/executor');
const { request, ensureWorkDir, cleanupRunArtifacts, uploadScreenshots, runnerErrorResult, createRunReporter } = require('../src/cli');
const { resolveRunnerConfig, CONFIG_FILE, LOCAL_CONFIG_FILE } = require('../src/config');

function printUsage() {
  console.log(`Usage:
  assert-runner [--config <path>]

Environment:
  ASSERT_API_KEY              Preferred API key env var
  ASSERT_WORK_DIR             Optional work directory
  ASSERT_KEEP_LOCAL_ARTIFACTS Keep per-run local artifacts after upload (default: false)
  ASSERT_POLL_INTERVAL_MS     Optional poll interval (default: 5000)
  ASSERT_IDLE_LOG_INTERVAL_MS Optional idle log interval (default: 60000)

Config files:
  ${CONFIG_FILE}
  ${LOCAL_CONFIG_FILE}
`);
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const opts = { configPath: process.env.ASSERT_CONFIG || null, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      opts.help = true;
      return opts;
    }
    if (arg === '--config') {
      opts.configPath = args[++i] || opts.configPath;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

const DEFAULTS = {
  apiBase: 'https://api.assert.click',
  pollIntervalMs: 5000,
  idleLogIntervalMs: 60000,
  workDir: path.join(os.tmpdir(), 'assert-runner'),
};

let cliOpts;
let runtimeConfig;
try {
  cliOpts = parseArgs(process.argv.slice(2));
  if (cliOpts.help) {
    printUsage();
    process.exit(0);
  }
  runtimeConfig = resolveRunnerConfig(cliOpts, {
    cwd: process.cwd(),
    env: process.env,
    ...DEFAULTS,
  });
} catch (err) {
  console.error(`Error: ${err?.message || String(err)}`);
  process.exit(1);
}

const API_KEY = runtimeConfig.apiKey;
const API_BASE = runtimeConfig.apiBase;
const POLL_INTERVAL_MS = Number(runtimeConfig.pollIntervalMs || DEFAULTS.pollIntervalMs);
const IDLE_LOG_INTERVAL_MS = Number(runtimeConfig.idleLogIntervalMs || DEFAULTS.idleLogIntervalMs);
const WORK_DIR = runtimeConfig.workDir || DEFAULTS.workDir;
const KEEP_LOCAL_ARTIFACTS = Boolean(runtimeConfig.keepLocalArtifacts);

if (!API_KEY) {
  console.error('Error: Assert API key is required.');
  console.error('Set ASSERT_API_KEY, configure projectApiKeyEnv, or store projectApiKey in assert.config.json.');
  process.exit(1);
}

ensureWorkDir(WORK_DIR);

async function pollJob() {
  try {
    const res = await request('GET', `${API_BASE}/v1/runner/jobs`, API_KEY, undefined, 30000);
    return res.job || null;
  } catch (err) {
    const message = err?.message || '';
    if (/invalid|unauthorized|forbidden/i.test(message)) {
      console.error('Unauthorized — check your ASSERT_API_KEY');
      process.exit(1);
    }
    if (/self-hosted runner is not enabled/i.test(message)) {
      console.error('Self-hosted runner is not enabled for this organisation.');
      console.error('Use `assert run <file-or-dir>` for one-off local runs, or enable self-hosted runners in Assert.');
      process.exit(1);
    }
    throw err;
  }
}

async function postResults(runId, results) {
  const passed = results.every((r) => r.passed !== false);
  return request('POST', `${API_BASE}/v1/runs/${runId}/results`, API_KEY, { results, passed }, 30000);
}

let running = false;
let connected = false;
let idlePollCount = 0;
let lastIdleLogAt = 0;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(message) {
  console.log(`[${timestamp()}] [assert-runner] ${message}`);
}

function logError(message) {
  console.error(`[${timestamp()}] [assert-runner] ${message}`);
}

function noteIdle() {
  idlePollCount += 1;
  const now = Date.now();
  if (idlePollCount === 1) {
    lastIdleLogAt = now;
    log(`Connected — waiting for jobs from ${API_BASE}`);
    return;
  }
  if (now - lastIdleLogAt >= IDLE_LOG_INTERVAL_MS) {
    lastIdleLogAt = now;
    log(`Still waiting for jobs — ${idlePollCount} idle poll${idlePollCount === 1 ? '' : 's'} so far`);
  }
}

async function tick() {
  if (running) return;
  try {
    const job = await pollJob();
    connected = true;
    if (!job) {
      noteIdle();
      return;
    }

    running = true;
    idlePollCount = 0;
    lastIdleLogAt = 0;
    const { runId, filename, tests, auth = null } = job;
    log(`Claimed run ${runId} (${filename})`);

    if (!Array.isArray(tests) || !tests.length) {
      console.warn(`[${timestamp()}] [assert-runner] No prepared tests in run ${runId}`);
      await postResults(runId, runnerErrorResult('Runner received job with no prepared tests')).catch(() => {});
      return;
    }

    let results;
    const reporter = createRunReporter({ prefix: 'assert-runner' });
    try {
      results = await executePreparedTests(tests, runId, { workDir: WORK_DIR, onEvent: reporter.event, auth });
    } catch (err) {
      reporter.stop();
      logError(`Error executing run ${runId}: ${err?.message || err}`);
      await postResults(runId, runnerErrorResult(err?.message || String(err))).catch(() => {});
      return;
    }
    reporter.stop();

    let uploadedScreenshots = false;
    try {
      await uploadScreenshots(API_BASE, API_KEY, WORK_DIR, runId, results);
      uploadedScreenshots = true;
    } catch (err) {
      console.warn(`[${timestamp()}] [assert-runner] Warning: failed to upload screenshots for run ${runId}: ${err?.message || err}`);
    }

    const passed = results.every((r) => r.passed !== false);
    log(`Run ${runId} complete — ${passed ? 'PASSED' : 'FAILED'} (${results.filter((r) => r.passed !== false).length}/${results.length} passed)`);
    await postResults(runId, results);
    if (!KEEP_LOCAL_ARTIFACTS && (uploadedScreenshots || !results.some((result) => Array.isArray(result?.steps) && result.steps.some((step) => step?.screenshot)))) {
      cleanupRunArtifacts(WORK_DIR, runId);
    }
  } catch (err) {
    if (!connected) {
      logError(`Initial poll failed: ${err?.message || err}`);
      return;
    }
    logError(`Poll error: ${err?.message || err}`);
  } finally {
    running = false;
  }
}

log(`Starting — polling ${API_BASE} every ${POLL_INTERVAL_MS / 1000}s`);
log(`Artifacts: ${WORK_DIR}`);

tick();
setInterval(tick, POLL_INTERVAL_MS);
