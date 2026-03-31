#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const { executePreparedTests } = require('../src/executor');
const { request, ensureWorkDir, uploadScreenshots, runnerErrorResult, logEvent } = require('../src/cli');

const API_KEY = process.env.ASSERT_API_KEY;
const API_BASE = (process.env.ASSERT_API_URL || 'https://api.assert.click').replace(/\/$/, '');
const POLL_INTERVAL_MS = Number(process.env.ASSERT_POLL_INTERVAL_MS || 5000);
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
    if (/invalid|unauthorized|forbidden/i.test(err?.message || '')) {
      console.error('Unauthorized — check your ASSERT_API_KEY');
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

async function tick() {
  if (running) return;
  try {
    const job = await pollJob();
    if (!job) return;

    running = true;
    const { runId, filename, tests } = job;
    console.log(`[assert-runner] Claimed run ${runId} (${filename})`);

    if (!Array.isArray(tests) || !tests.length) {
      console.warn(`[assert-runner] No prepared tests in run ${runId}`);
      await postResults(runId, runnerErrorResult('Runner received job with no prepared tests')).catch(() => {});
      return;
    }

    let results;
    try {
      results = await executePreparedTests(tests, runId, { workDir: WORK_DIR, onEvent: logEvent });
    } catch (err) {
      console.error(`[assert-runner] Error executing run ${runId}:`, err?.message || err);
      await postResults(runId, runnerErrorResult(err?.message || String(err))).catch(() => {});
      return;
    }

    try {
      await uploadScreenshots(API_BASE, API_KEY, WORK_DIR, runId, results);
    } catch (err) {
      console.warn(`[assert-runner] Warning: failed to upload screenshots for run ${runId}:`, err?.message || err);
    }

    const passed = results.every((r) => r.passed !== false);
    console.log(`[assert-runner] Run ${runId} complete — ${passed ? 'PASSED' : 'FAILED'} (${results.filter((r) => r.passed !== false).length}/${results.length} passed)`);
    await postResults(runId, results);
  } catch (err) {
    console.error('[assert-runner] Poll error:', err?.message || err);
  } finally {
    running = false;
  }
}

console.log(`[assert-runner] Starting — polling ${API_BASE} every ${POLL_INTERVAL_MS / 1000}s`);
console.log(`[assert-runner] Artifacts: ${WORK_DIR}`);

tick();
setInterval(tick, POLL_INTERVAL_MS);
