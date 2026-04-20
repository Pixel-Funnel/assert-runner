'use strict';
// Run: node packages/runner/preview-cli.js
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

// Logo
process.stdout.write('\n');
process.stdout.write(`  ${p.orange('▲')}  ${p.bold(p.orange('assert'))}\n`);
process.stdout.write('\n');

const reporter = createRunReporter({ prefix: 'assert' });

reporter.info(`Uploading ${p.bold('3')} files`);
reporter.info(`Running ${p.bold('3')} scenarios locally`);

// Scenario 1 — all pass
reporter.event({ type: 'scenario:start', index: 1, scenario: 'User can log in with valid credentials' });
reporter.event({ type: 'step', status: 'start', title: 'Navigate to https://app.example.com/login' });
reporter.event({ type: 'step', status: 'ok',    title: 'Navigate to https://app.example.com/login' });
reporter.event({ type: 'step', status: 'start', title: 'Fill in email with user@example.com' });
reporter.event({ type: 'step', status: 'ok',    title: 'Fill in email with user@example.com' });
reporter.event({ type: 'step', status: 'start', title: 'Click Sign in' });
reporter.event({ type: 'step', status: 'ok',    title: 'Click Sign in' });
reporter.event({ type: 'step', status: 'start', title: 'Expect "Welcome back" to be visible' });
reporter.event({ type: 'step', status: 'ok',    title: 'Expect "Welcome back" to be visible' });
reporter.event({ type: 'scenario:complete', index: 1, scenario: 'User can log in with valid credentials', passed: true });

// Scenario 2 — step fails
reporter.event({ type: 'scenario:start', index: 2, scenario: 'User can create a new ticket' });
reporter.event({ type: 'step', status: 'start', title: 'Navigate to /tickets' });
reporter.event({ type: 'step', status: 'ok',    title: 'Navigate to /tickets' });
reporter.event({ type: 'step', status: 'start', title: 'Click New Ticket' });
reporter.event({ type: 'step', status: 'ok',    title: 'Click New Ticket' });
reporter.event({ type: 'step', status: 'start', title: 'Fill in subject with Bug report' });
reporter.event({ type: 'step', status: 'fail',  title: 'Fill in subject with Bug report', error: '"Bug report" did not become visible within 10s' });
reporter.event({ type: 'scenario:complete', index: 2, scenario: 'User can create a new ticket', passed: false });

// Scenario 3 — all pass (with CDK overlay)
reporter.event({ type: 'scenario:start', index: 3, scenario: 'User can select Acme Limited from dropdown' });
reporter.event({ type: 'step', status: 'start', title: 'Click the company autocomplete field' });
reporter.event({ type: 'step', status: 'ok',    title: 'Click the company autocomplete field' });
reporter.event({ type: 'step', status: 'start', title: 'Type Acme' });
reporter.event({ type: 'step', status: 'ok',    title: 'Type Acme' });
reporter.event({ type: 'step', status: 'start', title: 'Wait for "Acme Limited" in CDK overlay' });
reporter.event({ type: 'step', status: 'ok',    title: 'Wait for "Acme Limited" in CDK overlay' });
reporter.event({ type: 'step', status: 'start', title: 'Click Acme Limited' });
reporter.event({ type: 'step', status: 'ok',    title: 'Click Acme Limited' });
reporter.event({ type: 'scenario:complete', index: 3, scenario: 'User can select Acme Limited from dropdown', passed: true });

reporter.stop();

// Final summary
process.stdout.write('\n');
process.stdout.write(`  ${p.red('✗')}  ${p.bold(p.red('Tests failed'))}  ${p.dim('1 failed, 2 passed, 3 total')}\n`);
process.stdout.write(`  ${p.dim('Run run_abc123xyz')}\n\n`);
