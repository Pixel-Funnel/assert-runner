#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const { executePreparedTests } = require('../src/executor');
const { request, ensureWorkDir, uploadScreenshots, runnerErrorResult, createRunReporter } = require('../src/cli');

const API_KEY = process.env.ASSERT_API_KEY;
const API_BASE = (process.env.ASSERT_API_URL || 'https://api.assert.click').replace(/\/$/, '');
const POLL_INTERVAL_MS = Number(process.env.ASSERT_POLL_INTERVAL_MS || 5000);
const IDLE_LOG_INTERVAL_MS = Number(process.env.ASSERT_IDLE_LOG_INTERVAL_MS || 60000);
const WORK_DIR = process.env.ASSERT_WORK_DIR || path.join(os.tmpdir(), 'assert-runner');

if (!API_KEY) {
  console.error('Error: ASSERT_API_KEY environment variable is required.');
  console.error('Usage: ASSERT_API_KEY=your_key assert-runner');
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
    const { runId, filename, tests } = job;
    log(`Claimed run ${runId} (${filename})`);

    if (!Array.isArray(tests) || !tests.length) {
      console.warn(`[${timestamp()}] [assert-runner] No prepared tests in run ${runId}`);
      await postResults(runId, runnerErrorResult('Runner received job with no prepared tests')).catch(() => {});
      return;
    }

    let results;
    const reporter = createRunReporter({ prefix: 'assert-runner' });
    try {
      results = await executePreparedTests(tests, runId, { workDir: WORK_DIR, onEvent: reporter.event });
    } catch (err) {
      reporter.stop();
      logError(`Error executing run ${runId}: ${err?.message || err}`);
      await postResults(runId, runnerErrorResult(err?.message || String(err))).catch(() => {});
      return;
    }
    reporter.stop();

    try {
      await uploadScreenshots(API_BASE, API_KEY, WORK_DIR, runId, results);
    } catch (err) {
      console.warn(`[${timestamp()}] [assert-runner] Warning: failed to upload screenshots for run ${runId}: ${err?.message || err}`);
    }

    const passed = results.every((r) => r.passed !== false);
    log(`Run ${runId} complete — ${passed ? 'PASSED' : 'FAILED'} (${results.filter((r) => r.passed !== false).length}/${results.length} passed)`);
    await postResults(runId, results);
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
