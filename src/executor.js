'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toPublicArtifactPath(runId, relPath) {
  return `/runs/${runId}/${String(relPath).replace(/\\/g, '/')}`;
}

function createScreenshotWriter({ workDir, runId, scenarioIndex }) {
  return async function writeStepScreenshot(page, stepIndex) {
    const relPath = path.posix.join('screenshots', `scenario_${scenarioIndex}_step_${stepIndex}_failure.png`);
    const targetPath = path.join(workDir, 'runs', runId, ...relPath.split('/'));
    ensureDir(path.dirname(targetPath));
    await page.screenshot({ path: targetPath, fullPage: true });
    return toPublicArtifactPath(runId, relPath);
  };
}

function buildRequireShim(testApi) {
  return function requireShim(id) {
    if (id === '@playwright/test') {
      return { test: testApi, expect };
    }
    throw new Error(`Unsupported module in prepared test: ${id}`);
  };
}

function loadPreparedSpec(code, filename, testApi) {
  const sandbox = {
    require: buildRequireShim(testApi),
    module: { exports: {} },
    exports: {},
    console,
    process,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.runInNewContext(String(code || ''), sandbox, { filename });
}

function createTestApi(activeExecutionRef, definitions, onEvent) {
  function test(name, fn) {
    definitions.push({ name: String(name || 'Scenario'), fn });
  }

  test.step = async (title, fn) => {
    const active = activeExecutionRef.current;
    if (!active) {
      return fn();
    }

    const step = { title: String(title || 'Step'), status: 'ok' };
    active.steps.push(step);
    try { onEvent && onEvent({ type: 'step', status: 'start', title: step.title }); } catch {}

    try {
      const result = await fn();
      try { onEvent && onEvent({ type: 'step', status: 'ok', title: step.title }); } catch {}
      return result;
    } catch (err) {
      step.status = 'fail';
      step.error = err?.message || String(err);
      if (!step.screenshot) {
        try {
          step.screenshot = await active.writeScreenshot(active.page, active.steps.length);
        } catch {}
      }
      try {
        onEvent && onEvent({
          type: 'step',
          status: 'fail',
          title: step.title,
          error: step.error,
          screenshot: step.screenshot || null,
        });
      } catch {}
      throw err;
    }
  };

  return test;
}

function loadDefinitionsForPreparedTest(preparedTest, onEvent) {
  const definitions = [];
  const activeExecutionRef = { current: null };
  const testApi = createTestApi(activeExecutionRef, definitions, onEvent);
  const filename = String(preparedTest?.playwright_path || preparedTest?.source_path || 'prepared.spec.js');
  loadPreparedSpec(preparedTest?.playwright_js, filename, testApi);
  return { definitions, activeExecutionRef };
}

async function executePreparedTests(preparedTests, runId, { workDir, onEvent = () => {} } = {}) {
  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const preparedTest of preparedTests || []) {
      const { definitions, activeExecutionRef } = loadDefinitionsForPreparedTest(preparedTest, onEvent);
      if (!definitions.length) {
        throw new Error(`Prepared test "${preparedTest?.source_path || preparedTest?.playwright_path || 'unknown'}" did not register any tests`);
      }

      for (const definition of definitions) {
        const scenarioIndex = results.length + 1;
        const scenarioName = definition.name || preparedTest?.scenario_name || preparedTest?.source_path || `Scenario ${scenarioIndex}`;
        const steps = [];
        const context = await browser.newContext();
        const page = await context.newPage();
        const writeScreenshot = createScreenshotWriter({ workDir, runId, scenarioIndex });

        try { onEvent({ type: 'scenario:start', index: scenarioIndex, scenario: scenarioName }); } catch {}

        let passed = false;
        try {
          activeExecutionRef.current = { page, steps, writeScreenshot };
          await definition.fn({ page, context, browser });
          passed = steps.every((step) => step.status !== 'fail');
        } catch (err) {
          const message = err?.message || String(err);
          const hasFailedStep = steps.some((step) => step.status === 'fail');
          if (!hasFailedStep) {
            const failureStep = {
              title: 'Scenario Error',
              status: 'fail',
              error: message,
            };
            try {
              failureStep.screenshot = await writeScreenshot(page, steps.length + 1);
            } catch {}
            steps.push(failureStep);
            try {
              onEvent({
                type: 'step',
                status: 'fail',
                title: failureStep.title,
                error: failureStep.error,
                screenshot: failureStep.screenshot || null,
              });
            } catch {}
          }
          passed = false;
        } finally {
          activeExecutionRef.current = null;
          try { await context.close(); } catch {}
        }

        results.push({
          index: scenarioIndex,
          scenario: scenarioName,
          passed,
          steps,
        });

        try { onEvent({ type: 'scenario:complete', index: scenarioIndex, passed }); } catch {}
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }

  return results;
}

module.exports = { executePreparedTests };
