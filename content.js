const api = typeof browser !== "undefined" ? browser : chrome;

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

async function findElement(selector, retries = 3, delayMs = 2000) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const element = document.querySelector(selector);
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
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
    await sleep(500);
  }
  throw new Error(`Timeout waiting for: ${selector}`);
}

function setInputValue(element, value) {
  element.focus();
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function buildCtx(data, variables, taskName, startIndex) {
  const getContext = () => ({ ...data, ...variables });
  const resolve = (value) => applyTemplate(value, getContext());
  const ctx = {
    data,
    variables,
    query(selector) {
      return document.querySelector(resolve(selector));
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
    async reload() {
      ctx._reloading = true;
      await api.runtime.sendMessage({
        type: "taskReload",
        nextIndex: startIndex,
        variables
      });
    },
    async log(message) {
      await api.runtime.sendMessage({
        type: "taskLog",
        taskName,
        message: String(message)
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

async function runSteps(payload) {
  const steps = payload.steps || [];
  const data = payload.data || {};
  const variables = { ...(payload.variables || {}) };
  const context = { ...data, ...variables };
  const startIndex = payload.startIndex || 0;
  const taskName = payload.taskName || "";

  for (let i = startIndex; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step || !step.action) {
      continue;
    }

    switch (step.action) {
      case "wait":
        await sleep(step.ms || 0);
        break;
      case "click": {
        const selector = applyTemplate(step.selector, context);
        const element = await findElement(selector);
        element.click();
        break;
      }
      case "getText": {
        const selector = applyTemplate(step.selector, context);
        const element = await findElement(selector);
        const text = (element.textContent || "").trim();
        if (step.as) {
          variables[step.as] = text;
          context[step.as] = text;
        }
        break;
      }
      case "type": {
        const selector = applyTemplate(step.selector, context);
        const element = await findElement(selector);
        const text = applyTemplate(step.text || "", context);
        setInputValue(element, text);
        break;
      }
      case "waitFor": {
        const selector = applyTemplate(step.selector, context);
        await waitForSelector(selector, step.timeout || 10000);
        break;
      }
      case "reload": {
        await api.runtime.sendMessage({
          type: "taskReload",
          nextIndex: i + 1,
          variables
        });
        return { status: "reloading" };
      }
      case "assert": {
        const variable = step.variable;
        const expected = applyTemplate(step.contains || "", context);
        const actual = variables[variable];
        if (actual === undefined || actual === null || !String(actual).includes(expected)) {
          return {
            success: false,
            message: step.failMsg || `Assertion failed: ${variable}`,
            variables,
            keepOpen: true
          };
        }
        break;
      }
      case "script": {
        const code = step.code || "";
        if (!code) {
          throw new Error("Missing script code");
        }
        const ctx = buildCtx(context, variables, taskName, i + 1);
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
  }

  return { success: true, message: "Task completed", variables };
}

async function runScript(payload) {
  const data = payload.data || {};
  const variables = { ...(payload.variables || {}) };
  const taskName = payload.taskName || "";
  const ctx = buildCtx({ ...data, ...variables }, variables, taskName, 0);
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
      variables: result.variables || variables
    };
  }
  return { success: true, message: "Script completed", variables };
}

if (!window.__WEBTASK_INJECTED__) {
  window.__WEBTASK_INJECTED__ = true;
  api.runtime.onMessage.addListener((message) => {
    if (!message || (message.type !== "runTask" && message.type !== "runScript")) {
      return undefined;
    }
    const runner = message.type === "runScript" ? runScript : runSteps;
    return runner(message).catch((error) => ({
      success: false,
      message: error.message || "Task error",
      keepOpen: false
    }));
  });
}
