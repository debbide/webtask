var api = typeof browser !== "undefined" ? browser : chrome;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyTemplate(value, context) {
  if (typeof value !== "string") {
    return value;
  }
  return value.replace(/\{(\w+)\}/g, (match, key) => {
    if (context && context[key] !== undefined && context[key] !== null) {
      return String(context[key]);
    }
    return match;
  });
}

function resolveHeaders(headers, context) {
  if (!headers) {
    return {};
  }
  let raw = headers;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (error) {
      return {};
    }
  }
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const resolved = {};
  Object.keys(raw).forEach((key) => {
    const value = raw[key];
    resolved[key] = typeof value === "string" ? applyTemplate(value, context) : value;
  });
  return resolved;
}

function resolveBody(body, context) {
  if (body === undefined || body === null) {
    return body;
  }
  if (typeof body === "string") {
    return applyTemplate(body, context);
  }
  if (typeof body === "object") {
    const resolved = Array.isArray(body) ? [] : {};
    Object.keys(body).forEach((key) => {
      const value = body[key];
      resolved[key] = typeof value === "string" ? applyTemplate(value, context) : value;
    });
    return resolved;
  }
  return body;
}

async function findElement(selector, retries = 3, delayMs = 2000) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const element = queryElement(selector);
    if (element) {
      return element;
    }
    if (attempt < retries - 1) {
      await sleep(delayMs);
    }
  }
  throw new Error(`Element not found: ${selector}`);
}

async function waitForSelector(selector, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const element = queryElement(selector);
    if (element) {
      return element;
    }
    await sleep(500);
  }
  throw new Error(`Timeout waiting for: ${selector}`);
}

function resolveSelectorTemplate(value, context) {
  if (typeof value === "string") {
    return applyTemplate(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveSelectorTemplate(item, context));
  }
  if (value && typeof value === "object") {
    const resolved = {};
    Object.keys(value).forEach((key) => {
      resolved[key] = resolveSelectorTemplate(value[key], context);
    });
    return resolved;
  }
  return value;
}

function normalizeSelectorCandidates(selector) {
  if (!selector) {
    return [];
  }
  if (typeof selector === "string") {
    return [selector];
  }
  if (Array.isArray(selector)) {
    return selector
      .map((item) => normalizeSelectorCandidates(item))
      .reduce((acc, list) => acc.concat(list), []);
  }
  if (typeof selector === "object") {
    const candidates = [];
    if (typeof selector.selector === "string") {
      candidates.push(selector.selector);
    }
    if (Array.isArray(selector.selectors)) {
      candidates.push(...normalizeSelectorCandidates(selector.selectors));
    }
    return candidates;
  }
  return [];
}

function isElementVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

function isElementEnabled(element) {
  return !!element && !element.disabled && element.getAttribute("aria-disabled") !== "true";
}

function querySelectorAllDeep(root, selector, includeShadow) {
  const results = [];
  if (!root || !selector) return results;
  try {
    results.push(...Array.from(root.querySelectorAll(selector)));
  } catch (error) {
    return results;
  }
  if (!includeShadow) return results;
  const elements = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
  for (const element of elements) {
    if (element.shadowRoot) {
      results.push(...querySelectorAllDeep(element.shadowRoot, selector, true));
    }
  }
  return results;
}

function getAllElementsDeep(root, includeShadow) {
  const results = root && root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
  if (!includeShadow) return results;
  for (const element of [...results]) {
    if (element.shadowRoot) {
      results.push(...getAllElementsDeep(element.shadowRoot, true));
    }
  }
  return results;
}

function getSelectorRoot(config) {
  if (!config || !config.frame) return document;
  const frame = queryElement(config.frame);
  if (!frame) return document;
  try {
    return frame.contentDocument || (frame.contentWindow && frame.contentWindow.document) || document;
  } catch (error) {
    return document;
  }
}

function queryElement(selector) {
  if (!selector) {
    return null;
  }
  const config = selector && typeof selector === "object" && !Array.isArray(selector) ? selector : null;
  const root = getSelectorRoot(config);
  const textContains =
    config && typeof config.textContains === "string" && config.textContains.trim()
      ? config.textContains
      : "";
  const textEquals =
    config && typeof config.textEquals === "string" && config.textEquals.trim()
      ? config.textEquals
      : "";
  const includeShadow = !!(config && config.shadow);
  const visibleOnly = !!(config && config.visible);
  const enabledOnly = !!(config && config.enabled);
  const index =
    config && Number.isFinite(Number(config.index)) && Number(config.index) >= 0
      ? Number(config.index)
      : 0;
  const candidates = normalizeSelectorCandidates(selector);

  for (const candidate of candidates) {
    const all = querySelectorAllDeep(root, candidate, includeShadow);
    const filtered = all.filter((element) => {
      const elementText = (element.textContent || "").trim();
      if (textContains && !elementText.includes(textContains)) return false;
      if (textEquals && elementText !== textEquals) return false;
      if (visibleOnly && !isElementVisible(element)) return false;
      if (enabledOnly && !isElementEnabled(element)) return false;
      return true;
    });
    if (filtered[index]) {
      return filtered[index];
    }
    if (filtered.length > 0) {
      return filtered[0];
    }
  }

  if ((textContains || textEquals) && candidates.length === 0) {
    const allNodes = getAllElementsDeep(root, includeShadow).filter((element) => {
      const elementText = (element.textContent || "").trim();
      if (textContains && !elementText.includes(textContains)) return false;
      if (textEquals && elementText !== textEquals) return false;
      if (visibleOnly && !isElementVisible(element)) return false;
      if (enabledOnly && !isElementEnabled(element)) return false;
      return true;
    });
    if (allNodes[index]) {
      return allNodes[index];
    }
    if (allNodes.length > 0) {
      return allNodes[0];
    }
  }
  return null;
}

function matchesCondition(condition, context) {
  if (!condition) return false;
  const value = context[condition.var];
  if (condition.exists === true && (value === undefined || value === null || value === "")) return false;
  if (condition.exists === false && value !== undefined && value !== null && value !== "") return false;
  if (condition.equals !== undefined && String(value) !== String(applyTemplate(condition.equals, context))) return false;
  if (condition.notEquals !== undefined && String(value) === String(applyTemplate(condition.notEquals, context))) return false;
  if (condition.contains !== undefined && !String(value || "").includes(String(applyTemplate(condition.contains, context)))) return false;
  return true;
}

function shouldSkipStep(step, context) {
  return !!(step && step.when && !matchesCondition(step.when, context));
}

function readElementValue(element, field) {
  if (!element) return "";
  if (Array.isArray(field)) {
    const values = {};
    field.forEach((item) => {
      values[item] = readElementValue(element, item);
    });
    return values;
  }
  if (field === "html") return element.innerHTML || "";
  if (field === "outerHTML") return element.outerHTML || "";
  if (field === "value") return element.value || "";
  if (field === "href") return element.href || element.getAttribute("href") || "";
  if (field === "src") return element.src || element.getAttribute("src") || "";
  if (field === "visible") return isElementVisible(element);
  if (field === "enabled") return isElementEnabled(element);
  if (field === "rect") {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  if (field && field.startsWith("attr:")) return element.getAttribute(field.slice(5)) || "";
  return (element.textContent || "").trim();
}

function setInputValue(element, value) {
  element.focus();
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function buildCtx(data, variables, taskName, startIndex, runId) {
  const getContext = () => ({ ...data, ...variables });
  const resolve = (value) => resolveSelectorTemplate(value, getContext());
  const ctx = {
    data,
    variables,
    runId,
    query(selector) {
      return queryElement(resolve(selector));
    },
    async click(selector) {
      const element = await findElement(resolve(selector));
      element.click();
    },
    async getText(selector) {
      const element = await findElement(resolve(selector));
      return (element.textContent || "").trim();
    },
    async type(selector, text) {
      const element = await findElement(resolve(selector));
      setInputValue(element, resolve(text));
    },
    async wait(ms) {
      await sleep(ms || 0);
    },
    async waitFor(selector, timeout) {
      await waitForSelector(resolve(selector), timeout || 10000);
    },
    async http(options) {
      const context = getContext();
      const url = resolve(options && options.url ? options.url : "");
      const headers = resolveHeaders(options && options.headers ? options.headers : {}, context);
      const body = resolveBody(options && options.body !== undefined ? options.body : undefined, context);
      const method = options && options.method ? String(options.method) : "GET";
      const responseType = options && options.responseType ? String(options.responseType) : "json";
      const timeoutMs = options && options.timeoutMs ? Number(options.timeoutMs) : 0;
      return api.runtime.sendMessage({
        type: "httpRequest",
        url,
        method,
        headers,
        body,
        responseType,
        timeoutMs
      });
    },
    async reload() {
      ctx._reloading = true;
      await api.runtime.sendMessage({
        type: "taskReload",
        nextIndex: startIndex,
        variables
      });
    },
    async navigate(url) {
      ctx._reloading = true;
      await api.runtime.sendMessage({
        type: "taskNavigate",
        url: resolve(url),
        nextIndex: startIndex,
        variables
      });
    },
    async log(message) {
      await api.runtime.sendMessage({
        type: "taskLog",
        taskName,
        message: String(message),
        runId
      });
    },
    _reloading: false
  };
  return ctx;
}

async function executeUserCode(code, ctx, mode) {
  const runner =
    mode === "body"
      ? new Function("ctx", `return (async () => { ${code}\n})();`)
      : new Function("ctx", `return (${code})(ctx);`);
  const result = await runner(ctx);
  if (ctx._reloading) {
    return { status: "reloading" };
  }
  return { result };
}

function withTimeout(promise, timeoutMs, label) {
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return promise;
  }
  let timeoutId = null;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout after ${timeout}ms`)), timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function buildDiagnostics() {
  const text = (document.body && document.body.innerText ? document.body.innerText : "").replace(/\s+/g, " ").trim();
  return {
    url: location.href,
    title: document.title || "",
    text: text.slice(0, 800)
  };
}

function buildStepFailure(step, index, message, variables, keepOpen) {
  return {
    success: false,
    message,
    variables,
    keepOpen: keepOpen !== undefined ? !!keepOpen : !!(step && step.keepOpen),
    failedStepIndex: index,
    failedStepAction: step && step.action ? step.action : "unknown",
    diagnostics: buildDiagnostics()
  };
}

async function executeStep(step, index, context, variables, taskName, runId) {
  switch (step.action) {
    case "wait":
      await sleep(step.ms || 0);
      break;
    case "stopIf":
      if (matchesCondition(step.condition, context)) {
        return { success: true, variables, stopped: true, message: step.message || "Stopped by condition" };
      }
      break;
    case "setVar": {
      const name = step.as || step.name;
      if (!name) {
        throw new Error("setVar requires as or name");
      }
      const value = applyTemplate(step.value !== undefined ? step.value : "", context);
      variables[name] = value;
      context[name] = value;
      break;
    }
    case "extract": {
      const selector = resolveSelectorTemplate(step.selector, context);
      const element = await findElement(selector);
      const value = readElementValue(element, step.field || "text");
      if (step.as) {
        variables[step.as] = value;
        context[step.as] = value;
      }
      break;
    }
    case "click": {
      const selector = resolveSelectorTemplate(step.selector, context);
      const element = await findElement(selector);
      element.click();
      break;
    }
    case "getText": {
      const selector = resolveSelectorTemplate(step.selector, context);
      const element = await findElement(selector);
      const text = (element.textContent || "").trim();
      if (step.as) {
        variables[step.as] = text;
        context[step.as] = text;
      }
      break;
    }
    case "type": {
      const selector = resolveSelectorTemplate(step.selector, context);
      const element = await findElement(selector);
      const text = applyTemplate(step.text || "", context);
      setInputValue(element, text);
      break;
    }
    case "waitFor": {
      const selector = resolveSelectorTemplate(step.selector, context);
      await waitForSelector(selector, step.timeout || 10000);
      break;
    }
    case "repeat": {
      const times = Number.isFinite(Number(step.times)) && Number(step.times) > 0 ? Math.floor(Number(step.times)) : 0;
      const nestedSteps = Array.isArray(step.steps) ? step.steps : [];
      for (let repeatIndex = 0; repeatIndex < times; repeatIndex += 1) {
        context.repeatIndex = repeatIndex;
        variables.repeatIndex = repeatIndex;
        for (let nestedIndex = 0; nestedIndex < nestedSteps.length; nestedIndex += 1) {
          const nestedStep = nestedSteps[nestedIndex];
          if (!nestedStep || !nestedStep.action) continue;
          if (shouldSkipStep(nestedStep, context)) continue;
          const result = await runStepWithPolicy(nestedStep, nestedIndex, context, variables, taskName, runId);
          if (result.status === "reloading" || !result.success) return result;
        }
      }
      break;
    }
    case "reload": {
      await api.runtime.sendMessage({
        type: "taskReload",
        nextIndex: index + 1,
        variables
      });
      return { status: "reloading" };
    }
    case "navigate": {
      const url = applyTemplate(step.url || step.path || "", context);
      if (!url) {
        throw new Error("Missing navigate url");
      }
      await api.runtime.sendMessage({
        type: "taskNavigate",
        url,
        nextIndex: index + 1,
        variables
      });
      return { status: "reloading" };
    }
    case "assert": {
      const variable = step.variable;
      const expected = applyTemplate(step.contains || "", context);
      const actual = variables[variable];
      if (actual === undefined || actual === null || !String(actual).includes(expected)) {
        return buildStepFailure(step, index, step.failMsg || `Assertion failed: ${variable}`, variables, true);
      }
      break;
    }
    case "http": {
      const url = applyTemplate(step.url || "", context);
      if (!url) {
        throw new Error("Missing http url");
      }
      const headers = resolveHeaders(step.headers, context);
      const body = resolveBody(step.body, context);
      const responseType = step.responseType || "json";
      const timeoutMs = step.timeoutMs || 0;
      const response = await api.runtime.sendMessage({
        type: "httpRequest",
        url,
        method: step.method || "GET",
        headers,
        body,
        responseType,
        timeoutMs
      });
      if (step.failOnStatus && !response.ok) {
        return buildStepFailure(step, index, response.error || `HTTP ${response.status}`, variables, step.keepOpen);
      }
      if (step.as) {
        variables[step.as] = response.data;
        context[step.as] = response.data;
      }
      if (step.asStatus) {
        variables[step.asStatus] = response.status;
        context[step.asStatus] = response.status;
      }
      if (step.asHeaders) {
        variables[step.asHeaders] = response.headers;
        context[step.asHeaders] = response.headers;
      }
      break;
    }
    case "script": {
      const code = step.code || "";
      if (!code) {
        throw new Error("Missing script code");
      }
      const ctx = buildCtx(context, variables, taskName, index + 1, runId);
      const outcome = await executeUserCode(code, ctx, "body");
      if (outcome.status === "reloading") {
        return { status: "reloading" };
      }
      if (step.as) {
        variables[step.as] = outcome.result;
        context[step.as] = outcome.result;
      }
      break;
    }
    default:
      throw new Error(`Unknown action: ${step.action}`);
  }
  return { success: true, variables };
}

async function sendStepLog(taskName, runId, message) {
  await api.runtime.sendMessage({
    type: "taskLog",
    taskName,
    message,
    runId
  });
}

async function runStepWithPolicy(step, index, context, variables, taskName, runId) {
  const retries = Number.isFinite(Number(step.retries)) && Number(step.retries) > 0 ? Math.floor(Number(step.retries)) : 0;
  const attempts = retries + 1;
  let lastMessage = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const stepLabel = `Step ${index + 1} ${step.action}`;
    await sendStepLog(taskName, runId, `${stepLabel} started${attempt > 0 ? ` retry ${attempt}` : ""}`);
    try {
      const result = await withTimeout(
        executeStep(step, index, context, variables, taskName, runId),
        step.timeoutMs || step.timeout,
        `Step ${index + 1} ${step.action}`
      );
      if (result.status === "reloading") {
        await sendStepLog(taskName, runId, `${stepLabel} requested reload`);
        return result;
      }
      if (result.success) {
        await sendStepLog(taskName, runId, result.stopped ? `${stepLabel} stopped task` : `${stepLabel} succeeded`);
        return result;
      }
      lastMessage = result.message || "Step failed";
      await sendStepLog(taskName, runId, `${stepLabel} failed: ${lastMessage}`);
      if (attempt >= attempts - 1) {
        if (step.onFail === "continue") {
          await sendStepLog(taskName, runId, `${stepLabel} continued after failure`);
          return { success: true, variables, continued: true, message: lastMessage };
        }
        return result;
      }
    } catch (error) {
      lastMessage = error && error.message ? error.message : "Step error";
      await sendStepLog(taskName, runId, `${stepLabel} failed: ${lastMessage}`);
      if (attempt >= attempts - 1) {
        const onFail = step.onFail || "stop";
        if (onFail === "continue") {
          await sendStepLog(taskName, runId, `${stepLabel} continued after failure`);
          return { success: true, variables, continued: true, message: lastMessage };
        }
        return buildStepFailure(step, index, lastMessage, variables, step.keepOpen);
      }
    }
    await sleep(300);
  }
  return buildStepFailure(step, index, lastMessage || "Step failed", variables, step.keepOpen);
}

async function runSteps(payload) {
  const steps = payload.steps || [];
  const data = payload.data || {};
  const variables = { ...(payload.variables || {}) };
  const context = { ...data, ...variables };
  const startIndex = payload.startIndex || 0;
  const taskName = payload.taskName || "";
  const runId = payload.runId || "";

  for (let i = startIndex; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step || !step.action) {
      continue;
    }
    if (shouldSkipStep(step, context)) {
      await sendStepLog(taskName, runId, `Step ${i + 1} ${step.action} skipped by condition`);
      continue;
    }
    const result = await runStepWithPolicy(step, i, context, variables, taskName, runId);
    if (result.status === "reloading") {
      return { status: "reloading" };
    }
    if (result.stopped) {
      return { success: true, message: result.message || "Task stopped by condition", variables };
    }
    if (!result.success) {
      if (step.onFail === "continue") {
        continue;
      }
      return result;
    }
  }

  return { success: true, message: "Task completed", variables };
}

async function runScript(payload) {
  const data = payload.data || {};
  const variables = { ...(payload.variables || {}) };
  const taskName = payload.taskName || "";
  const runId = payload.runId || "";
  const ctx = buildCtx({ ...data, ...variables }, variables, taskName, 0, runId);
  const code = payload.script || "";
  if (!code) {
    throw new Error("Missing script");
  }
  const outcome = await executeUserCode(code, ctx, "function");
  if (outcome.status === "reloading") {
    return { status: "reloading" };
  }
  const result = outcome.result || {};
  if (typeof result === "object" && ("success" in result || "message" in result)) {
    return {
      success: !!result.success,
      message: result.message || "",
      keepOpen: !!result.keepOpen,
      variables: result.variables || variables,
      nextRunAt: result.nextRunAt
    };
  }
  return { success: true, message: "Script completed", variables };
}

if (!window.__WEBTASK_INJECTED__) {
  window.__WEBTASK_INJECTED__ = true;
  api.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") {
      return undefined;
    }
    if (message.type === "webtaskPing") {
      return Promise.resolve({ ok: true });
    }
    if (message.type !== "runTask" && message.type !== "runScript") {
      return undefined;
    }
    const runner = message.type === "runScript" ? runScript : runSteps;
    return runner(message).catch((error) => ({
      success: false,
      message: error.message || "Task error",
      keepOpen: false,
      diagnostics: buildDiagnostics()
    }));
  });
}
