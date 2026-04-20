'use strict';
// node packages/runner/demo-cli.js
const { createRunReporter } = require('./src/cli.js');

function makeColors(enabled) {
  const tc = (r, g, b) => (t) => enabled ? `\x1b[38;2;${r};${g};${b}m${t}\x1b[0m` : t;
  return {
    orange: tc(247, 112, 21),
    green:  tc(34, 197, 94),
    red:    tc(239, 68, 68),
    dim:    (t) => enabled ? `\x1b[2m${t}\x1b[0m` : t,
    bold:   (t) => enabled ? `\x1b[1m${t}\x1b[0m` : t,
  };
}

const p = makeColors(true);

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function runStep(reporter, title, ms, fail = false, errorMsg = '') {
  reporter.event({ type: 'step', status: 'start', title });
  await sleep(ms);
  if (fail) {
    reporter.event({ type: 'step', status: 'fail', title, error: errorMsg });
  } else {
    reporter.event({ type: 'step', status: 'ok', title });
  }
}

async function main() {
  process.stdout.write('\n');
  process.stdout.write(`  ${p.orange('▲')}  ${p.bold(p.orange('assert'))}\n`);
  process.stdout.write('\n');

  const reporter = createRunReporter({ prefix: 'assert' });

  reporter.info(`Uploading ${p.bold('3')} files`);
  reporter.info(`Running ${p.bold('3')} scenarios locally`);

  // ── Scenario 1: passes ──────────────────────────────────────────
  reporter.event({ type: 'scenario:start', index: 1, scenario: 'User can log in with valid credentials' });
  await runStep(reporter, 'Navigate to https://app.testme.digital/login', 600);
  await runStep(reporter, 'Fill "email" with user@example.com', 400);
  await runStep(reporter, 'Fill "password" with ••••••••', 300);
  await runStep(reporter, 'Click "Sign in"', 800);
  await runStep(reporter, 'Expect "Welcome back" to be visible', 500);
  reporter.event({ type: 'scenario:complete', index: 1, scenario: 'User can log in with valid credentials', passed: true });
  await sleep(200);

  // ── Scenario 2: one step fails ──────────────────────────────────
  reporter.event({ type: 'scenario:start', index: 2, scenario: 'User can create a new air job (LHR → LAX)' });
  await runStep(reporter, 'Navigate to /jobs/new', 500);
  await runStep(reporter, 'Wait for "New Job" in page-header', 700);
  await runStep(reporter, 'Click "Air"', 400);
  await runStep(reporter, 'Fill "customer" with Acme', 600);
  await runStep(
    reporter,
    'Wait for "Acme Limited" in dropdown',
    2200,
    true,
    '"Acme Limited" did not become visible within 10s'
  );
  reporter.event({
    type: 'scenario:complete',
    index: 2,
    scenario: 'User can create a new air job (LHR → LAX)',
    passed: false,
  });
  await sleep(200);

  // ── Scenario 3: passes ──────────────────────────────────────────
  reporter.event({ type: 'scenario:start', index: 3, scenario: 'User can view existing shipments' });
  await runStep(reporter, 'Navigate to /shipments', 500);
  await runStep(reporter, 'Wait for shipment table to load', 900);
  await runStep(reporter, 'Expect "Shipment #1042" to be visible', 400);
  await runStep(reporter, 'Click row "Shipment #1042"', 300);
  await runStep(reporter, 'Expect shipment detail panel to be visible', 600);
  reporter.event({ type: 'scenario:complete', index: 3, scenario: 'User can view existing shipments', passed: true });

  reporter.stop();

  process.stdout.write('\n');
  process.stdout.write(`  ${p.red('✗')}  ${p.bold(p.red('Tests failed'))}  ${p.dim('1 failed, 2 passed, 3 total')}\n`);
  process.stdout.write(`  ${p.dim('Run 4318d9e8-0aae-40a3-98c8-584cc83a02aa')}\n\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
