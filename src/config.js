'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'assert.config.json';
const LOCAL_CONFIG_FILE = 'assert.config.local.json';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = cloneValue(inner);
    return out;
  }
  return value;
}

function mergeConfig(base, extra) {
  const out = isPlainObject(base) ? cloneValue(base) : {};
  if (!isPlainObject(extra)) return out;
  for (const [key, value] of Object.entries(extra)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeConfig(out[key], value);
      continue;
    }
    out[key] = cloneValue(value);
  }
  return out;
}

function readConfigFile(absPath) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read ${path.basename(absPath)}: ${err?.message || String(err)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${path.basename(absPath)}: ${err?.message || String(err)}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${path.basename(absPath)} must contain a JSON object`);
  }
  return parsed;
}

function findConfigDirectory(startDir) {
  let current = path.resolve(startDir || process.cwd());
  while (true) {
    const basePath = path.join(current, CONFIG_FILE);
    const localPath = path.join(current, LOCAL_CONFIG_FILE);
    if (fs.existsSync(basePath) || fs.existsSync(localPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveExplicitConfigTarget(cwd, configPath) {
  const target = path.resolve(cwd || process.cwd(), configPath);
  if (!fs.existsSync(target)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    return {
      configDir: target,
      files: [path.join(target, CONFIG_FILE), path.join(target, LOCAL_CONFIG_FILE)].filter((filePath) => fs.existsSync(filePath)),
    };
  }
  const configDir = path.dirname(target);
  const baseName = path.basename(target);
  if (baseName === CONFIG_FILE) {
    return {
      configDir,
      files: [target, path.join(configDir, LOCAL_CONFIG_FILE)].filter((filePath) => fs.existsSync(filePath)),
    };
  }
  if (baseName === LOCAL_CONFIG_FILE) {
    return {
      configDir,
      files: [path.join(configDir, CONFIG_FILE), target].filter((filePath) => fs.existsSync(filePath)),
    };
  }
  return { configDir, files: [target] };
}

function loadAssertConfig(options = {}) {
  const cwd = options.cwd || process.cwd();
  const configPath = options.configPath || process.env.ASSERT_CONFIG || null;

  let configDir = null;
  let files = [];
  let baseConfig = {};
  let localConfig = {};
  if (configPath) {
    const explicit = resolveExplicitConfigTarget(cwd, configPath);
    configDir = explicit.configDir;
    files = explicit.files;
  } else {
    configDir = findConfigDirectory(cwd);
    if (configDir) {
      files = [path.join(configDir, CONFIG_FILE), path.join(configDir, LOCAL_CONFIG_FILE)].filter((filePath) => fs.existsSync(filePath));
    }
  }

  let config = {};
  for (const filePath of files) {
    const parsed = readConfigFile(filePath);
    const baseName = path.basename(filePath);
    if (baseName === LOCAL_CONFIG_FILE) {
      localConfig = mergeConfig(localConfig, parsed);
    } else {
      baseConfig = mergeConfig(baseConfig, parsed);
    }
    config = mergeConfig(config, parsed);
  }

  return {
    config,
    baseConfig,
    localConfig,
    configDir,
    files,
  };
}

function readString(source, keys) {
  if (!isPlainObject(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function readNumber(source, keys) {
  if (!isPlainObject(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readStringArray(source, keys) {
  if (!isPlainObject(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      const items = value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
      return items.length ? items : [];
    }
  }
  return null;
}

function readInputEntries(source, keys) {
  if (!isPlainObject(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return [value.trim()];
    if (Array.isArray(value)) {
      const items = value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
      return items.length ? items : [];
    }
  }
  return null;
}

function resolvePathFrom(baseDir, value) {
  if (!value) return null;
  if (path.isAbsolute(value)) return value;
  return path.resolve(baseDir || process.cwd(), value);
}

function resolvePathArray(baseDir, values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => resolvePathFrom(baseDir, value)).filter(Boolean);
}

function sectionFor(config, sectionName) {
  if (!isPlainObject(config)) return {};
  const section = config[sectionName];
  return isPlainObject(section) ? section : {};
}

function resolveApiKey(env, commonConfig, toolConfig) {
  const envName =
    readString(toolConfig, ['projectApiKeyEnv']) ||
    readString(commonConfig, ['projectApiKeyEnv']);
  const envCandidates = ['ASSERT_API_KEY'];
  if (envName && !envCandidates.includes(envName)) envCandidates.push(envName);
  for (const name of envCandidates) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return (
    readString(toolConfig, ['projectApiKey']) ||
    readString(commonConfig, ['projectApiKey']) ||
    null
  );
}

function resolveCliConfig(rawOpts, defaults = {}) {
  const env = defaults.env || process.env;
  const loaded = loadAssertConfig({ cwd: defaults.cwd, configPath: rawOpts.configPath || env.ASSERT_CONFIG });
  const common = loaded.config || {};
  const configDir = loaded.configDir || defaults.cwd || process.cwd();

  return {
    config: loaded,
    apiKey: resolveApiKey(env, common, {}),
    projectId:
      rawOpts.projectId ||
      env.ASSERT_PROJECT_ID ||
      readString(common, ['projectId', 'project_id']) ||
      null,
    apiBase: String(defaults.apiBase || '').replace(/\/$/, ''),
    workDir:
      resolvePathFrom(configDir, rawOpts.workDir) ||
      (env.ASSERT_WORK_DIR ? path.resolve(env.ASSERT_WORK_DIR) : null) ||
      resolvePathFrom(configDir, readString(common, ['workDir'])) ||
      defaults.workDir,
    inputs: rawOpts.inputs.length
      ? rawOpts.inputs
      : resolvePathArray(configDir, readInputEntries(common, ['input']) ?? []),
  };
}

function resolveRunnerConfig(rawOpts = {}, defaults = {}) {
  const env = defaults.env || process.env;
  const loaded = loadAssertConfig({ cwd: defaults.cwd, configPath: rawOpts.configPath || env.ASSERT_CONFIG });
  const common = loaded.config || {};
  const runner = sectionFor(common, 'runner');
  const configDir = loaded.configDir || defaults.cwd || process.cwd();

  return {
    config: loaded,
    apiKey: resolveApiKey(env, common, runner),
    apiBase: String(defaults.apiBase || '').replace(/\/$/, ''),
    workDir:
      (env.ASSERT_WORK_DIR ? path.resolve(env.ASSERT_WORK_DIR) : null) ||
      resolvePathFrom(configDir, readString(runner, ['workDir'])) ||
      resolvePathFrom(configDir, readString(common, ['workDir'])) ||
      defaults.workDir,
    pollIntervalMs:
      readNumber({ value: env.ASSERT_POLL_INTERVAL_MS }, ['value']) ||
      readNumber(runner, ['pollIntervalMs', 'poll_interval_ms']) ||
      readNumber(common, ['pollIntervalMs', 'poll_interval_ms']) ||
      defaults.pollIntervalMs,
    idleLogIntervalMs:
      readNumber({ value: env.ASSERT_IDLE_LOG_INTERVAL_MS }, ['value']) ||
      readNumber(runner, ['idleLogIntervalMs', 'idle_log_interval_ms']) ||
      readNumber(common, ['idleLogIntervalMs', 'idle_log_interval_ms']) ||
      defaults.idleLogIntervalMs,
  };
}

module.exports = {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  loadAssertConfig,
  resolveCliConfig,
  resolveRunnerConfig,
};
