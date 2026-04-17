'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');

function stripAnsi(value) {
  return String(value || '').replace(/\u001b\[[0-9;]*m/g, '');
}

function extractLocatorSubject(msg) {
  const t = msg.match(/getByText\(\s*['"](.+?)['"]/);
  if (t) return `"${t[1]}"`;
  const l = msg.match(/getByLabel\(\s*['"](.+?)['"]/);
  if (l) return `"${l[1]}"`;
  const p = msg.match(/getByPlaceholder\(\s*['"](.+?)['"]/);
  if (p) return `"${p[1]}"`;
  const r = msg.match(/getByRole\(\s*['"]?(\w+)['"]?(?:,\s*\{[^}]*name:\s*['"](.+?)['"])?/);
  if (r) return r[2] ? `"${r[2]}"` : `${r[1]} element`;
  return null;
}

function humanizeError(err) {
  const msg = stripAnsi(err?.message || String(err));

  // 1. Strict mode: locator matched multiple elements
  const strictMatch = msg.match(/strict mode violation[^:]*:\s*(\S+)\s*resolved to (\d+) elements/i);
  if (strictMatch) {
    const subject = extractLocatorSubject(strictMatch[1]) || strictMatch[1];
    return `${subject} matched ${strictMatch[2]} elements on the page — use a more specific label or add "in container-name" to narrow it down`;
  }

  // 2a. toBeVisible timed out — element exists but wasn't visible within the timeout
  if (/toBeVisible\(\) failed/i.test(msg)) {
    const subject = extractLocatorSubject(msg) || 'Element';
    const timeoutMatch = msg.match(/timeout (\d+)ms/i);
    const secs = timeoutMatch ? Math.round(Number(timeoutMatch[1]) / 1000) : null;
    return secs
      ? `${subject} did not become visible within ${secs}s — it may still be loading`
      : `${subject} did not become visible — it may still be loading`;
  }

  // 2b. waitFor visible timed out — locator matched nothing visible
  if (/No matching locator became visible/i.test(msg)) {
    const subject = extractLocatorSubject(msg) || 'Element';
    return `${subject} was not visible — the page may need more time to load`;
  }

  // 3. Locator timeout — element never appeared in DOM
  const locatorTimeoutMatch = msg.match(/locator\.[a-z]+: Timeout (\d+)ms exceeded/i);
  if (locatorTimeoutMatch) {
    const subject = extractLocatorSubject(msg) || 'Element';
    const secs = Math.round(Number(locatorTimeoutMatch[1]) / 1000);
    return `${subject} did not appear on the page within ${secs}s`;
  }

  // 4. Element detached from DOM
  if (/is not attached to the (DOM|document)/i.test(msg)) {
    const subject = extractLocatorSubject(msg) || 'Element';
    return `${subject} disappeared from the page before the step could complete`;
  }

  // 5. Click intercepted — covered by another element
  if (/intercepts pointer events|covered by another element|pointer-events: none/i.test(msg)) {
    const subject = extractLocatorSubject(msg) || 'Element';
    return `${subject} is hidden behind another element and could not be clicked`;
  }

  // 6. Element not enabled / disabled
  if (/element is not enabled|is disabled/i.test(msg)) {
    const subject = extractLocatorSubject(msg) || 'Element';
    return `${subject} is disabled`;
  }

  // 7. Element not editable / read-only
  if (/element is not editable|is read-?only/i.test(msg)) {
    const subject = extractLocatorSubject(msg) || 'Element';
    return `${subject} is read-only and cannot be edited`;
  }

  // 8. Navigation timeout (page.goto)
  if (/page\.goto.*timeout|navigation timeout/i.test(msg)) {
    const urlMatch = msg.match(/https?:\/\/[^\s'"]+/);
    return urlMatch ? `Page timed out loading ${urlMatch[0]}` : 'Page took too long to load';
  }

  // 9/10. Network error (includes SSL/cert errors)
  const netMatch = msg.match(/net::(ERR_\w+)/);
  if (netMatch) {
    const code = netMatch[1];
    if (/ERR_CERT/i.test(code)) return `Page has an SSL certificate error (${code})`;
    if (/ERR_CONNECTION_REFUSED/i.test(code)) return 'Connection refused — is the server running?';
    if (/ERR_NAME_NOT_RESOLVED/i.test(code)) return 'Domain could not be resolved — check the URL';
    return `Page failed to load (${code})`;
  }

  // 11. Page or target closed unexpectedly
  if (/target.*closed|page.*closed|browser.*closed/i.test(msg)) {
    return 'The browser tab closed unexpectedly';
  }

  // 12. Execution context destroyed (page navigated mid-step)
  if (/execution context was destroyed|navigating/i.test(msg)) {
    return 'The page navigated away while the step was running';
  }

  // 13. toHaveText mismatch
  const haveTextMatch = msg.match(/toHaveText\(\) failed[\s\S]*?Expected string:\s*(.+?)\n[\s\S]*?Received string:\s*(.+?)\n/i);
  if (haveTextMatch || /toHaveText\(\) failed/i.test(msg)) {
    if (haveTextMatch) return `Text didn't match — expected "${haveTextMatch[1].trim()}", got "${haveTextMatch[2].trim()}"`;
    return 'Element text did not match what was expected';
  }

  // 14. toHaveURL mismatch
  const haveUrlMatch = msg.match(/toHaveURL\(\) failed[\s\S]*?Expected string:\s*(.+?)\n[\s\S]*?Received string:\s*(.+?)\n/i);
  if (haveUrlMatch || /toHaveURL\(\) failed/i.test(msg)) {
    if (haveUrlMatch) return `Ended up on the wrong page — expected "${haveUrlMatch[1].trim()}", got "${haveUrlMatch[2].trim()}"`;
    return 'The page URL did not match what was expected';
  }

  // 15. toHaveValue mismatch
  const haveValueMatch = msg.match(/toHaveValue\(\) failed[\s\S]*?Expected string:\s*(.+?)\n[\s\S]*?Received string:\s*(.+?)\n/i);
  if (haveValueMatch || /toHaveValue\(\) failed/i.test(msg)) {
    if (haveValueMatch) return `Field value didn't match — expected "${haveValueMatch[1].trim()}", got "${haveValueMatch[2].trim()}"`;
    return 'Field value did not match what was expected';
  }

  // 16. Select option not found
  if (/no options were found|option.*not found|selectOption/i.test(msg)) {
    const optMatch = msg.match(/option ['"](.+?)['"]/i);
    return optMatch ? `Option "${optMatch[1]}" was not found in the dropdown` : 'The dropdown option was not found';
  }

  // 17. Unable to fill (custom — no matching input found)
  const unableToFillMatch = msg.match(/Unable to fill ["']?(.+?)["']?$/i);
  if (unableToFillMatch) {
    return `Could not find a field matching "${unableToFillMatch[1].trim()}" on the page`;
  }

  // 18. Unable to submit login form (custom)
  if (/Unable to submit/i.test(msg)) {
    return 'Could not find a submit button to click';
  }

  // 19. waitForNavigation timeout
  if (/waitForNavigation.*Timeout|waitForURL.*Timeout/i.test(msg)) {
    return 'The page did not navigate as expected';
  }

  // 20. Element outside viewport
  if (/outside.*viewport|not.*in.*viewport/i.test(msg)) {
    const subject = extractLocatorSubject(msg) || 'Element';
    return `${subject} is outside the visible area of the page`;
  }

  // 21. toHaveCount mismatch
  const haveCountMatch = msg.match(/toHaveCount\(\) failed[\s\S]*?Expected:?\s*(\d+)[\s\S]*?Received:?\s*(\d+)/i);
  if (haveCountMatch || /toHaveCount\(\) failed/i.test(msg)) {
    if (haveCountMatch) return `Expected ${haveCountMatch[1]} item${haveCountMatch[1] === '1' ? '' : 's'} but found ${haveCountMatch[2]}`;
    return 'The number of matching elements did not match what was expected';
  }

  // 22. toBeChecked failed
  if (/toBeChecked\(\) failed|expected.*to be checked|expected.*not to be checked/i.test(msg)) {
    const subject = extractLocatorSubject(msg) || 'Checkbox';
    return `${subject} was not in the expected checked state`;
  }

  // 23. toContainText failed
  const containTextMatch = msg.match(/toContainText\(\) failed[\s\S]*?Expected string:\s*(.+?)\n/i);
  if (containTextMatch || /toContainText\(\) failed/i.test(msg)) {
    if (containTextMatch) return `Page did not contain the text "${containTextMatch[1].trim()}"`;
    return 'Expected text was not found on the page';
  }

  // 24. toHaveAttribute failed
  const haveAttrMatch = msg.match(/toHaveAttribute\(\) failed[\s\S]*?Expected:?\s*['"]?(.+?)['"]?\n[\s\S]*?Received:?\s*['"]?(.+?)['"]?\n/i);
  if (haveAttrMatch || /toHaveAttribute\(\) failed/i.test(msg)) {
    if (haveAttrMatch) return `Attribute didn't match — expected "${haveAttrMatch[1].trim()}", got "${haveAttrMatch[2].trim()}"`;
    return 'Element attribute did not match what was expected';
  }

  // 25. toHaveClass failed
  const haveClassMatch = msg.match(/toHaveClass\(\) failed[\s\S]*?Expected:?\s*['"]?(.+?)['"]?\n/i);
  if (haveClassMatch || /toHaveClass\(\) failed/i.test(msg)) {
    if (haveClassMatch) return `Element did not have the expected class "${haveClassMatch[1].trim()}"`;
    return 'Element did not have the expected CSS class';
  }

  // 26. Element not focusable
  if (/element is not focusable|not focusable/i.test(msg)) {
    const subject = extractLocatorSubject(msg) || 'Element';
    return `${subject} cannot be focused — it may be hidden or not interactive`;
  }

  // 27. Too many redirects
  if (/too many redirects/i.test(msg)) {
    return 'The page is stuck in a redirect loop';
  }

  // 28. waitForLoadState timeout
  if (/waitForLoadState.*Timeout|waitForLoadState.*exceeded/i.test(msg)) {
    return 'The page did not finish loading in time';
  }

  // 29. waitForFunction timeout — custom condition never met
  if (/waitForFunction.*Timeout|waitForFunction.*exceeded/i.test(msg)) {
    return 'A page condition was not met in time';
  }

  // 30. page.evaluate / JS execution error
  if (/page\.evaluate|frame\.evaluate/i.test(msg)) {
    const jsErrMatch = msg.match(/(?:page|frame)\.evaluate[^:]*:\s*(.+)/i);
    return jsErrMatch ? `JavaScript error on the page: ${jsErrMatch[1].trim()}` : 'A JavaScript error occurred on the page';
  }

  // 31. Protocol / DevTools connection error
  if (/protocol error|cdp.*error|devtools.*error/i.test(msg)) {
    return 'Lost connection to the browser — the page may have crashed';
  }

  // 32. Frame detached (distinct from page closed)
  if (/frame.*detached|frame was detached/i.test(msg)) {
    return 'The page section being tested was removed from the page';
  }

  // 33. HTTP error status on navigation
  const httpErrorMatch = msg.match(/(?:received|got|status)\s+(4\d\d|5\d\d)/i) || msg.match(/\b(404|403|401|500|502|503)\b/);
  if (httpErrorMatch) {
    const code = httpErrorMatch[1];
    if (code === '401' || code === '403') return `Access denied (HTTP ${code}) — the page requires authentication`;
    if (code === '404') return `Page not found (HTTP 404) — check the URL`;
    if (code === '500') return `The server returned an error (HTTP 500)`;
    return `The page returned an error (HTTP ${code})`;
  }

  // 34. Unexpected alert/dialog blocking interaction
  if (/dialog.*blocking|unexpected.*alert|unhandled.*dialog/i.test(msg)) {
    return 'An unexpected popup or alert is blocking the page';
  }

  // 35. Hover/mouse timeout
  if (/locator\.hover.*Timeout|hover.*exceeded/i.test(msg)) {
    const subject = extractLocatorSubject(msg) || 'Element';
    return `${subject} did not respond to hover`;
  }

  // 36. Drag and drop failed
  if (/locator\.drag|dragTo.*Timeout|drag.*exceeded/i.test(msg)) {
    return 'The drag and drop operation failed or timed out';
  }

  // 37. File input error
  if (/setInputFiles|input.*type.*file|file.*upload/i.test(msg)) {
    return 'File upload failed — the input may not be a file field';
  }

  // 38. waitForResponse / waitForRequest timeout
  if (/waitForResponse.*Timeout|waitForRequest.*Timeout/i.test(msg)) {
    return 'An expected network request did not happen in time';
  }

  // 39. JSHandle / element handle disposed
  if (/jshandle.*disposed|element.*handle.*disposed/i.test(msg)) {
    return 'The element was removed from the page before the step could finish';
  }

  // 40. Invalid CSS selector syntax
  if (/is not valid.*selector|failed to execute.*querySelector|syntaxerror.*selector/i.test(msg)) {
    return 'Invalid selector — the locator syntax is not valid';
  }

  // General timeout fallback
  if (/timed out|timeout.*exceeded/i.test(msg)) return 'Step timed out';

  // Fall back to first line only — strip multiline Playwright noise
  return msg.split('\n')[0].trim();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toPublicArtifactPath(runId, relPath) {
  return `/runs/${runId}/${String(relPath).replace(/\\/g, '/')}`;
}

function cssEscape(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLoginLikeUrl(value) {
  return /\/(login|log-in|signin|sign-in|auth)\b/i.test(String(value || ''));
}

function isUsableAuth(auth) {
  return Boolean(auth && auth.username != null && auth.password != null);
}

function getPageUrl(page, fallback = '') {
  try {
    return page && typeof page.url === 'function' ? (page.url() || fallback) : fallback;
  } catch {
    return fallback;
  }
}

function toCompactUrl(value, pageHost = '') {
  try {
    const parsed = new URL(String(value || ''));
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    if ((pageHost && parsed.host && parsed.host !== pageHost) || path === '/') {
      return `${parsed.host}${path}`;
    }
    return path;
  } catch {
    return String(value || '');
  }
}

function createAuthDiagnostics(page) {
  let pageHost = '';
  try {
    const href = getPageUrl(page, '');
    if (href) pageHost = new URL(href).host;
  } catch {}

  const state = {
    requests: [],
    failures: [],
    consoleErrors: [],
    pageErrors: [],
  };

  const recordRequest = async (request, response = null) => {
    try {
      const method = request.method();
      const url = request.url();
      const interesting = /login|signin|sign-in|auth|session|token/i.test(url) || /POST|PUT|PATCH/i.test(method);
      if (!interesting) return;
      const entry = {
        method,
        url: toCompactUrl(url, pageHost),
        status: response ? response.status() : null,
      };
      let requestHeaders = null;
      try {
        if (typeof request.headers === 'function') {
          requestHeaders = request.headers();
        }
      } catch {}
      const amzTarget = requestHeaders?.['x-amz-target'] || requestHeaders?.['X-Amz-Target'] || null;
      if (amzTarget) {
        entry.target = amzTarget;
      }
      if (response && response.status() >= 400) {
        try {
          const text = String(await response.text() || '').trim();
          if (text) {
            try {
              const parsed = JSON.parse(text);
              entry.error = parsed?.message || parsed?.Message || parsed?.error || parsed?.__type || text.slice(0, 180);
            } catch {
              entry.error = text.replace(/\s+/g, ' ').slice(0, 180);
            }
          }
        } catch {}
      }
      state.requests.push(entry);
      if (state.requests.length > 6) state.requests.shift();
    } catch {}
  };

  const onResponse = (response) => {
    try { void recordRequest(response.request(), response); } catch {}
  };
  const onRequestFailed = (request) => {
    try {
      state.failures.push({
        method: request.method(),
        url: toCompactUrl(request.url(), pageHost),
        error: request.failure()?.errorText || 'request failed',
      });
      if (state.failures.length > 4) state.failures.shift();
    } catch {}
  };
  const onConsole = (msg) => {
    try {
      if (msg.type() !== 'error') return;
      state.consoleErrors.push(String(msg.text() || '').trim().replace(/\s+/g, ' ').slice(0, 200));
      if (state.consoleErrors.length > 4) state.consoleErrors.shift();
    } catch {}
  };
  const onPageError = (err) => {
    try {
      state.pageErrors.push(String(err?.message || err || '').trim().replace(/\s+/g, ' ').slice(0, 200));
      if (state.pageErrors.length > 4) state.pageErrors.shift();
    } catch {}
  };

  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  return {
    snapshot() {
      return {
        requests: state.requests.slice(),
        failures: state.failures.slice(),
        consoleErrors: state.consoleErrors.slice(),
        pageErrors: state.pageErrors.slice(),
      };
    },
    stop() {
      try { page.off('response', onResponse); } catch {}
      try { page.off('requestfailed', onRequestFailed); } catch {}
      try { page.off('console', onConsole); } catch {}
      try { page.off('pageerror', onPageError); } catch {}
    },
  };
}

async function describeLocator(locator, fallback = 'element') {
  try {
    return await locator.first().evaluate((node) => {
      if (!node) return null;
      const parts = [];
      const tag = node.tagName ? node.tagName.toLowerCase() : 'element';
      parts.push(tag);
      const type = node.getAttribute?.('type');
      const name = node.getAttribute?.('name');
      const id = node.getAttribute?.('id');
      const placeholder = node.getAttribute?.('placeholder');
      const dataAssert = node.getAttribute?.('data-assert');
      const ariaLabel = node.getAttribute?.('aria-label');
      const text = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (type) parts.push(`type=${type}`);
      if (name) parts.push(`name=${name}`);
      if (id) parts.push(`id=${id}`);
      if (placeholder) parts.push(`placeholder=${placeholder}`);
      if (dataAssert) parts.push(`data-assert=${dataAssert}`);
      if (ariaLabel) parts.push(`aria-label=${ariaLabel}`);
      if (text) parts.push(`text=${text}`);
      return parts.join(' ');
    });
  } catch {
    return fallback;
  }
}

async function collectLoginPageSnapshot(page) {
  try {
    return await page.evaluate(() => {
      const isVisible = (node) => {
        if (!node) return false;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const errorSelectors = [
        '[role="alert"]',
        '[aria-live="assertive"]',
        '.error',
        '.errors',
        '.alert-warning',
        '.text-danger',
        '.alert-danger',
        '.invalid-feedback',
        '.mat-error',
        'mat-error',
        '[data-error]',
      ];

      const errorTexts = Array.from(document.querySelectorAll(errorSelectors.join(',')))
        .filter(isVisible)
        .map((node) => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .slice(0, 3);

      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'))
        .filter(isVisible)
        .map((node) => (node.innerText || node.value || node.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '))
        .filter(Boolean)
        .slice(0, 5);

      const inputs = Array.from(document.querySelectorAll('input, textarea'))
        .filter(isVisible)
        .map((node) => {
          const type = (node.getAttribute('type') || node.tagName || '').toLowerCase();
          const name = node.getAttribute('name') || node.getAttribute('id') || node.getAttribute('placeholder') || '';
          return `${type}${name ? `:${name}` : ''}`;
        })
        .filter(Boolean)
        .slice(0, 8);

      return { errorTexts, buttons, inputs };
    });
  } catch {
    return { errorTexts: [], buttons: [], inputs: [] };
  }
}

async function waitForQuiet(page, timeoutMs = 5000) {
  try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(2000, timeoutMs) }); } catch {}
  try { await page.waitForLoadState('networkidle', { timeout: timeoutMs }); } catch {}
  try { await page.waitForTimeout(150); } catch {}
}

async function waitForPageReadyForInteraction(page, timeoutMs = 12000) {
  const startedAt = Date.now();
  const remaining = () => Math.max(500, timeoutMs - (Date.now() - startedAt));

  try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(2500, timeoutMs) }); } catch {}
  try { await page.waitForFunction(() => document.readyState === 'interactive' || document.readyState === 'complete', { timeout: Math.min(2500, remaining()) }); } catch {}

  try {
    const preloader = page.locator('.preloader').first();
    if (await locatorExists(preloader, { timeout: 500 })) {
      await page.waitForFunction(() => {
        const node = document.querySelector('.preloader');
        if (!node) return true;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          node.className.includes('preloader-hidden') ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0' ||
          rect.width === 0 ||
          rect.height === 0
        );
      }, { timeout: remaining() }).catch(() => {});
    }
  } catch {}

  try {
    await page.waitForFunction(() => {
      const body = document.body;
      if (!body) return true;
      return window.getComputedStyle(body).overflow !== 'hidden';
    }, { timeout: Math.min(3000, remaining()) }).catch(() => {});
  } catch {}

  try { await page.waitForLoadState('networkidle', { timeout: Math.min(3000, remaining()) }); } catch {}
  try { await page.waitForTimeout(250); } catch {}
}

async function locatorExists(locator, { visible = false, timeout = 1200 } = {}) {
  try {
    if (visible) {
      await locator.first().waitFor({ state: 'visible', timeout });
      return true;
    }
    return (await locator.count()) > 0;
  } catch {
    return false;
  }
}

async function pageLooksLikeLogin(page, auth) {
  const href = getPageUrl(page, '');
  if (isLoginLikeUrl(href)) return true;

  const passwordVisible = await locatorExists(page.locator('input[type="password"], input[autocomplete="current-password"]').first(), {
    visible: true,
    timeout: 1200,
  });
  if (!passwordVisible) return false;

  const usernameHint = String(auth?.usernameField || 'email');
  const submitVisible =
    await locatorExists(page.locator('button[type="submit"], input[type="submit"]').first(), { visible: true, timeout: 900 }) ||
    await locatorExists(page.getByRole('button', { name: /log.?in|sign.?in|continue|submit/i, exact: false }).first(), { visible: true, timeout: 900 });
  const userVisible =
    await locatorExists(page.getByLabel(usernameHint, { exact: false }).first(), { visible: true, timeout: 900 }) ||
    await locatorExists(page.getByPlaceholder(usernameHint, { exact: false }).first(), { visible: true, timeout: 900 }) ||
    await locatorExists(page.locator('input[type="email"], input[autocomplete="username"], input[name*="email" i], input[name*="user" i]').first(), {
      visible: true,
      timeout: 900,
    });

  return submitVisible || userVisible;
}

async function fillByGuess(page, field, value) {
  const raw = String(field || '').trim();
  const slug = slugify(raw);
  const re = new RegExp(escapeRegExp(raw), 'i');
  const candidates = [];
  const push = (locator) => { if (locator) candidates.push(locator); };

  if (raw) {
    push(page.locator(`[data-assert="${cssEscape(raw)}"]`).first());
    if (slug && slug !== raw) push(page.locator(`[data-assert="${cssEscape(slug)}"]`).first());
    push(page.locator(`[data-assert*="${cssEscape(raw)}" i]`).first());
    push(page.getByLabel(raw, { exact: false }).first());
    push(page.getByPlaceholder(raw, { exact: false }).first());
    push(page.locator(`input[name="${cssEscape(raw)}"], textarea[name="${cssEscape(raw)}"], input[id="${cssEscape(raw)}"], textarea[id="${cssEscape(raw)}"]`).first());
    push(page.locator(`input[name*="${cssEscape(raw)}" i], textarea[name*="${cssEscape(raw)}" i], input[id*="${cssEscape(raw)}" i], textarea[id*="${cssEscape(raw)}" i]`).first());
    push(page.getByLabel(re, { exact: false }).first());
    push(page.getByPlaceholder(re, { exact: false }).first());
  }

  if (/email|user(name)?/i.test(raw)) {
    push(page.locator('input[type="email"]').first());
    push(page.locator('input[autocomplete="username"]').first());
    push(page.locator('input[name*="email" i], input[id*="email" i], input[name*="user" i], input[id*="user" i]').first());
    push(page.locator('input:not([type="hidden"]):not([type="password"])').first());
  }

  if (/password|passcode|pass phrase|passphrase/i.test(raw)) {
    push(page.locator('input[type="password"]').first());
    push(page.locator('input[autocomplete="current-password"], input[name*="pass" i], input[id*="pass" i]').first());
  }

  let lastErr = null;
  for (const locator of candidates) {
    try {
      if (!await locatorExists(locator)) continue;
      await locator.first().waitFor({ state: 'visible', timeout: 2500 });
      const target = locator.first();
      const tag = await target.evaluate((node) => (node && node.tagName ? node.tagName.toLowerCase() : '')).catch(() => '');
      const contentEditable = await target.evaluate((node) => !!node && (node.isContentEditable || node.getAttribute('contenteditable') === 'true')).catch(() => false);
      if (contentEditable && tag !== 'input' && tag !== 'textarea') {
        await target.click({ timeout: 1500 }).catch(() => {});
        try { await page.keyboard.press('Control+A'); } catch {}
        try { await page.keyboard.press('Delete'); } catch {}
        await page.keyboard.type(String(value ?? ''));
      } else {
        await target.fill(String(value ?? ''));
      }
      await target.blur().catch(() => {});
      await page.waitForTimeout(100).catch(() => {});
      await waitForQuiet(page, 1200);
      return await describeLocator(target, raw || 'field');
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error(`Unable to fill "${raw || 'field'}"`);
}

async function submitByEnter(page) {
  let lastErr = null;
  try {
    const passwordField = page.locator('input[type="password"]').first();
    if (await locatorExists(passwordField, { visible: true, timeout: 1200 })) {
      await passwordField.press('Enter');
      await waitForQuiet(page, 4000);
      return 'keyboard:Enter on password field';
    }
  } catch (err) {
    lastErr = err;
  }
  throw lastErr || new Error('Unable to submit with Enter on password field');
}

async function submitByButton(page, label) {
  const candidates = [];
  const push = (locator) => { if (locator) candidates.push(locator); };

  if (label) {
    push(page.getByRole('button', { name: label, exact: false }).first());
    push(page.locator(`button[aria-label*="${cssEscape(label)}" i], input[type="submit"][value*="${cssEscape(label)}" i]`).first());
  }

  push(page.getByRole('button', { name: /log.?in|sign.?in|continue|submit/i, exact: false }).first());
  push(page.locator('button[type="submit"]').first());
  push(page.locator('input[type="submit"]').first());

  let lastErr = null;
  for (const locator of candidates) {
    try {
      if (!await locatorExists(locator)) continue;
      await locator.first().waitFor({ state: 'visible', timeout: 2000 });
      const target = locator.first();
      await target.click();
      await waitForQuiet(page, 4000);
      return await describeLocator(target, label || 'submit');
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('Unable to submit login form with button click');
}

async function submitByGuess(page, label, { preferEnter = false } = {}) {
  let firstErr = null;
  let secondErr = null;

  if (preferEnter) {
    try {
      return await submitByEnter(page);
    } catch (err) {
      firstErr = err;
    }
    try {
      return await submitByButton(page, label);
    } catch (err) {
      secondErr = err;
    }
  } else {
    try {
      return await submitByButton(page, label);
    } catch (err) {
      firstErr = err;
    }
    try {
      return await submitByEnter(page);
    } catch (err) {
      secondErr = err;
    }
  }

  throw secondErr || firstErr || new Error('Unable to submit login form');
}

async function authLooksSuccessful({ page, context, auth }) {
  if (auth?.successText) {
    const ok = await locatorExists(page.getByText(auth.successText, { exact: false }).first(), { visible: true, timeout: 1200 });
    if (ok) return true;
  }

  const looksLikeLogin = await pageLooksLikeLogin(page, auth);
  if (!looksLikeLogin) return true;

  const href = getPageUrl(page, '');
  if (!isLoginLikeUrl(href)) {
    return true;
  }

  try {
    const cookies = await context.cookies();
    return cookies.length > 0 && !isLoginLikeUrl(href);
  } catch {
    return false;
  }
}

async function buildAuthFailureDetails({ page, context, auth, beforeCookies = [], attempts = {}, diagnostics = null } = {}) {
  const href = getPageUrl(page, 'unknown');
  const details = {
    title: null,
    url: href,
    stillOnLoginUrl: isLoginLikeUrl(href),
    loginFormVisible: false,
    successText: auth?.successText || null,
    successTextVisible: null,
    newCookiesSet: null,
    fields: {
      username: attempts.username || null,
      password: attempts.password || null,
      submit: attempts.submit || null,
    },
    visible: {
      errors: [],
      buttons: [],
      inputs: [],
    },
    network: {
      requests: Array.isArray(diagnostics?.requests) ? diagnostics.requests : [],
      failures: Array.isArray(diagnostics?.failures) ? diagnostics.failures : [],
    },
    consoleErrors: Array.isArray(diagnostics?.consoleErrors) ? diagnostics.consoleErrors : [],
    pageErrors: Array.isArray(diagnostics?.pageErrors) ? diagnostics.pageErrors : [],
  };

  try {
    details.title = await page.title().catch(() => null);
  } catch {}

  try {
    details.loginFormVisible = await pageLooksLikeLogin(page, auth);
  } catch {}

  if (auth?.successText) {
    try {
      details.successTextVisible = await locatorExists(
        page.getByText(auth.successText, { exact: false }).first(),
        { visible: true, timeout: 1000 }
      );
    } catch {}
  }

  try {
    const afterCookies = await context.cookies();
    details.newCookiesSet = afterCookies.some((cookie) => !beforeCookies.some((prev) => prev.name === cookie.name && prev.domain === cookie.domain && prev.path === cookie.path));
  } catch {}

  try {
    const snapshot = await collectLoginPageSnapshot(page);
    details.visible.errors = Array.isArray(snapshot.errorTexts) ? snapshot.errorTexts : [];
    details.visible.buttons = Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
    details.visible.inputs = Array.isArray(snapshot.inputs) ? snapshot.inputs : [];
  } catch {}

  return details;
}

function summarizeAuthFailureDetails(details) {
  const reasons = [];
  if (details?.stillOnLoginUrl) reasons.push('still on login URL');
  if (details?.loginFormVisible) reasons.push('login form is still visible');
  if (details?.successText && details?.successTextVisible === false) reasons.push(`success text "${details.successText}" not visible`);
  if (details?.newCookiesSet === false) reasons.push('no new cookies were set');
  if (Array.isArray(details?.visible?.errors) && details.visible.errors.length) reasons.push(`page error: ${details.visible.errors[0]}`);
  if (!details?.network?.requests?.length) reasons.push('no auth-like network requests observed');
  return `Authentication did not complete successfully${reasons.length ? ` (${reasons.join('; ')})` : ''}`;
}

function guessPostLoginUrl(loginUrl) {
  try {
    const parsed = new URL(String(loginUrl || ''));
    return `${parsed.origin}/`;
  } catch {
    return String(loginUrl || '');
  }
}

async function performLogin(page, context, auth, { onEvent = () => {}, mode = 'bootstrap', targetUrl = null } = {}) {
  if (!isUsableAuth(auth)) return false;

  const loginUrl = String(auth.url || '').trim();
  const currentUrl = getPageUrl(page, '');
  const shouldVisitLoginUrl = Boolean(loginUrl) && !(await pageLooksLikeLogin(page, auth));

  if (shouldVisitLoginUrl) {
    try { onEvent({ type: 'auth:start', mode, url: loginUrl }); } catch {}
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await waitForPageReadyForInteraction(page, 12000);
  } else {
    try { onEvent({ type: 'auth:start', mode, url: currentUrl || loginUrl || null }); } catch {}
    await waitForPageReadyForInteraction(page, 12000);
  }

  const beforeCookies = await context.cookies().catch(() => []);
  const diagnostics = createAuthDiagnostics(page);
  const attempts = { username: null, password: null, submit: null };
  try {
    attempts.username = await fillByGuess(page, auth.usernameField || 'email', auth.username);
  } catch (err) {
    throw new Error(`Unable to fill login username/email field "${auth.usernameField || 'email'}": ${stripAnsi(err?.message || String(err))}`);
  }

  try {
    attempts.password = await fillByGuess(page, auth.passwordField || 'password', auth.password);
  } catch (err) {
    throw new Error(`Unable to fill login password field "${auth.passwordField || 'password'}": ${stripAnsi(err?.message || String(err))}`);
  }

  await waitForPageReadyForInteraction(page, 4000);

  try {
    attempts.submit = await submitByGuess(page, auth.submit, { preferEnter: true });
  } catch (err) {
    throw new Error(`Unable to submit login form${auth.submit ? ` using "${auth.submit}"` : ''}: ${stripAnsi(err?.message || String(err))}`);
  }

  await Promise.race([
    auth?.successText
      ? page.getByText(auth.successText, { exact: false }).first().waitFor({ state: 'visible', timeout: 12000 })
      : Promise.reject(new Error('no-success-text')),
    page.waitForNavigation({ timeout: 12000 }).catch(() => {}),
    page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {}),
    page.waitForTimeout(1500),
  ]).catch(() => {});
  await waitForQuiet(page, 4000);

  let authed = await authLooksSuccessful({ page, context, auth });
  if (!authed) {
    try {
      const retrySubmit = attempts.submit === 'keyboard:Enter on password field'
        ? await submitByGuess(page, auth.submit, { preferEnter: false })
        : await submitByGuess(page, auth.submit, { preferEnter: true });
      attempts.submit = `${attempts.submit} | retry:${retrySubmit}`;
      await Promise.race([
        auth?.successText
          ? page.getByText(auth.successText, { exact: false }).first().waitFor({ state: 'visible', timeout: 12000 })
          : Promise.reject(new Error('no-success-text')),
        page.waitForNavigation({ timeout: 12000 }).catch(() => {}),
        page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {}),
        page.waitForTimeout(1500),
      ]).catch(() => {});
      await waitForQuiet(page, 4000);
      authed = await authLooksSuccessful({ page, context, auth });
    } catch {}
  }

  if (!authed && targetUrl) {
    await page.goto(String(targetUrl), { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForQuiet(page, 4000);
    authed = await authLooksSuccessful({ page, context, auth });
  }

  if (!authed && loginUrl) {
    const postUrl = guessPostLoginUrl(loginUrl);
    if (postUrl && postUrl !== targetUrl) {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForQuiet(page, 4000);
      authed = await authLooksSuccessful({ page, context, auth });
    }
  }

  if (!authed) {
    const afterCookies = await context.cookies().catch(() => []);
    const gainedCookie = afterCookies.some((cookie) => !beforeCookies.some((prev) => prev.name === cookie.name && prev.domain === cookie.domain && prev.path === cookie.path));
    authed = gainedCookie && !(await pageLooksLikeLogin(page, auth));
  }

  if (!authed) {
    const details = await buildAuthFailureDetails({
      page,
      context,
      auth,
      beforeCookies,
      attempts,
      diagnostics: diagnostics.snapshot(),
    });
    const message = summarizeAuthFailureDetails(details);
    try { onEvent({ type: 'auth:error', mode, message, details }); } catch {}
    diagnostics.stop();
    const error = new Error(message);
    error.authDetails = details;
    throw error;
  }

  diagnostics.stop();
  try { onEvent({ type: 'auth:complete', mode, url: getPageUrl(page, loginUrl || null) }); } catch {}
  return true;
}

async function createBootstrapStorageState(browser, auth, onEvent) {
  if (!isUsableAuth(auth) || !auth?.url) return null;

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await performLogin(page, context, auth, { onEvent, mode: 'bootstrap' });
    return await context.storageState();
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
  }
}

async function handleLoginRedirect(page, context, auth, targetUrl, onEvent) {
  if (!isUsableAuth(auth)) return false;
  const looksLikeLogin = await pageLooksLikeLogin(page, auth);
  if (!looksLikeLogin) return false;

  try { onEvent({ type: 'auth:redirect', url: getPageUrl(page, null), targetUrl: targetUrl || null }); } catch {}
  await performLogin(page, context, auth, { onEvent, mode: 'redirect', targetUrl });
  if (targetUrl) {
    const href = getPageUrl(page, '');
    if (href !== String(targetUrl)) {
      await page.goto(String(targetUrl), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitForQuiet(page, 4000);
    }
  }
  return true;
}

function createAuthenticatedPage(page, context, auth, onEvent, authState = null) {
  if (!isUsableAuth(auth)) return page;

  return new Proxy(page, {
    get(target, prop, receiver) {
      if (prop === 'goto') {
        return async (...args) => {
          const targetUrl = args[0] != null ? String(args[0]) : null;
          if (authState && targetUrl) authState.lastRequestedUrl = targetUrl;
          const result = await target.goto(...args);
          const currentUrl = getPageUrl(target, '');
          if (authState && currentUrl && !isLoginLikeUrl(currentUrl)) {
            authState.lastStableUrl = currentUrl;
          }
          await handleLoginRedirect(target, context, auth, targetUrl, onEvent);
          const finalUrl = getPageUrl(target, '');
          if (authState && finalUrl && !isLoginLikeUrl(finalUrl)) {
            authState.lastStableUrl = finalUrl;
          }
          return result;
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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
      if (typeof active.ensureLoggedIn === 'function') {
        await active.ensureLoggedIn();
      }
      const result = await fn();
      try { onEvent && onEvent({ type: 'step', status: 'ok', title: step.title }); } catch {}
      return result;
    } catch (err) {
      step.status = 'fail';
      step.error = humanizeError(err);
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

async function executePreparedTests(preparedTests, runId, { workDir, onEvent = () => {}, auth = null, showBrowser = false } = {}) {
  const loadedTests = [];
  let totalScenarios = 0;

  for (const preparedTest of preparedTests || []) {
    const { definitions, activeExecutionRef } = loadDefinitionsForPreparedTest(preparedTest, onEvent);
    if (!definitions.length) {
      throw new Error(`Prepared test "${preparedTest?.source_path || preparedTest?.playwright_path || 'unknown'}" did not register any tests`);
    }
    loadedTests.push({ preparedTest, definitions, activeExecutionRef });
    totalScenarios += definitions.length;
  }

  try { onEvent({ type: 'run:start', totalScenarios }); } catch {}

  const browser = await chromium.launch({ headless: !showBrowser });
  const results = [];
  let storageState = null;

  try {
    storageState = await createBootstrapStorageState(browser, auth, onEvent);

    for (const { preparedTest, definitions, activeExecutionRef } of loadedTests) {
      for (const definition of definitions) {
        const scenarioIndex = results.length + 1;
        const scenarioName = definition.name || preparedTest?.scenario_name || preparedTest?.source_path || `Scenario ${scenarioIndex}`;
        const steps = [];
        const context = storageState ? await browser.newContext({ storageState }) : await browser.newContext();
        const rawPage = await context.newPage();
        const authState = { lastRequestedUrl: null, lastStableUrl: null };
        rawPage.on('framenavigated', (frame) => {
          try {
            if (frame !== rawPage.mainFrame()) return;
            const href = frame.url();
            if (href && !isLoginLikeUrl(href)) {
              authState.lastStableUrl = href;
            }
          } catch {}
        });
        const ensureLoggedIn = async () => {
          if (!isUsableAuth(auth)) return false;
          const targetUrl = authState.lastRequestedUrl || authState.lastStableUrl || null;
          const handled = await handleLoginRedirect(rawPage, context, auth, targetUrl, onEvent);
          const href = getPageUrl(rawPage, '');
          if (href && !isLoginLikeUrl(href)) {
            authState.lastStableUrl = href;
          }
          return handled;
        };
        const page = createAuthenticatedPage(rawPage, context, auth, onEvent, authState);
        const writeScreenshot = createScreenshotWriter({ workDir, runId, scenarioIndex });

        try { onEvent({ type: 'scenario:start', index: scenarioIndex, scenario: scenarioName }); } catch {}

        let passed = false;
        try {
          activeExecutionRef.current = { page: rawPage, steps, writeScreenshot, ensureLoggedIn };
          await definition.fn({ page, context, browser });
          passed = steps.every((step) => step.status !== 'fail');
        } catch (err) {
          const message = stripAnsi(err?.message || String(err));
          const hasFailedStep = steps.some((step) => step.status === 'fail');
          if (!hasFailedStep) {
            const failureStep = {
              title: 'Scenario Error',
              status: 'fail',
              error: message,
            };
            try {
              failureStep.screenshot = await writeScreenshot(rawPage, steps.length + 1);
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
          source_path: preparedTest?.source_path || null,
          passed,
          steps,
        });

        try {
          onEvent({
            type: 'scenario:complete',
            index: scenarioIndex,
            scenario: scenarioName,
            passed,
            stepCount: steps.length,
          });
        } catch {}
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }

  return results;
}

module.exports = { executePreparedTests };
