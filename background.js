const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULT_WEBHOOK_URL = "http://localhost:3000";
const DEFAULT_POLL_INTERVAL_MINUTES = 0.25;
const TASK_TIMEOUT_MS = 60000;
const LOG_LIMIT = 10;
const DEFAULT_PROTOCOL = "webtask";
const WS_RECONNECT_BASE_MS = 2000;
const WS_RECONNECT_MAX_MS = 60000;
const HEARTBEAT_INTERVAL_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_TASKS = [
  {
    name: "minestrator_restart",
    label: "Minestrator Restart",
    url: "https://minestrator.com/my/server/{serverId}",
    defaultData: { serverId: "421301" },
    enabled: true,
    steps: [
      { action: "wait", ms: 5000 },
      { action: "click", selector: "button[class*='bg-info']" },
      { action: "wait", ms: 8000 },
      { action: "getText", selector: "[class*='ring-warning']", as: "timer" },
      { action: "assert", variable: "timer", contains: "3h 5", failMsg: "Timer not reset" }
    ]
  }
];

let currentJob = null;
let wsClient = null;
let wsReconnectTimer = null;
let wsReconnectAttempts = 0;

async function getStoredState() {
  const data = await api.storage.local.get([
    "webhookUrl",
    "webtaskApiKey",
    "connection",
    "taskStatus",
    "logs",
    "pollIntervalMinutes",
    "tasks",
    "protocol",
    "shuaxinCursor",
    "clientId"
  ]);
  return {
    webhookUrl: data.webhookUrl || DEFAULT_WEBHOOK_URL,
    webtaskApiKey: data.webtaskApiKey || "",
    connection: data.connection || { connected: false, lastError: "", lastCheck: 0 },
    taskStatus: data.taskStatus || {},
    logs: data.logs || [],
    pollIntervalMinutes: data.pollIntervalMinutes || DEFAULT_POLL_INTERVAL_MINUTES,
    tasks: data.tasks || [],
    protocol: data.protocol || DEFAULT_PROTOCOL,
    shuaxinCursor: data.shuaxinCursor || "0",
    clientId: data.clientId || ""
  };
}

async function ensureDefaults() {
  const data = await api.storage.local.get([
    "webhookUrl",
    "webtaskApiKey",
    "connection",
    "taskStatus",
    "logs",
    "pollIntervalMinutes",
    "tasks",
    "protocol",
    "shuaxinCursor",
    "clientId"
  ]);
  const updates = {};
  if (!data.webhookUrl) {
    updates.webhookUrl = DEFAULT_WEBHOOK_URL;
  }
  if (!data.webtaskApiKey) {
    updates.webtaskApiKey = "";
  }
  if (!data.connection) {
    updates.connection = { connected: false, lastError: "", lastCheck: 0 };
  }
  if (!data.taskStatus) {
    updates.taskStatus = {};
  }
  if (!data.logs) {
    updates.logs = [];
  }
  if (!data.pollIntervalMinutes) {
    updates.pollIntervalMinutes = DEFAULT_POLL_INTERVAL_MINUTES;
  }
  if (!data.tasks) {
    updates.tasks = [];
  }
  if (!data.protocol) {
    updates.protocol = DEFAULT_PROTOCOL;
  }
  if (!data.shuaxinCursor) {
    updates.shuaxinCursor = "0";
  }
  if (!data.clientId) {
    updates.clientId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  if (Object.keys(updates).length) {
    await api.storage.local.set(updates);
  }
}

async function schedulePolling(intervalMinutes) {
  const minutes = intervalMinutes || DEFAULT_POLL_INTERVAL_MINUTES;
  await api.alarms.clear("webtask_poll");
  api.alarms.create("webtask_poll", { periodInMinutes: minutes });
}

function toWsUrl(httpUrl) {
  if (!httpUrl) return "";
  try {
    const parsed = new URL(httpUrl);
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    return parsed.toString().replace(/\/+$/, "");
  } catch (error) {
    return "";
  }
}

function buildWebtaskApiBase(webhookUrl) {
  const baseUrl = (webhookUrl || "").replace(/\/+$/, "");
  return baseUrl.endsWith("/api/webtask") ? baseUrl : `${baseUrl}/api/webtask`;
}

function buildAuthHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["X-API-KEY"] = apiKey;
    headers["Authorization"] = `Bearer ${apiKey}`;
  }
  return headers;
}

function clearWsReconnectTimer() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

function clearJobHeartbeat(job) {
  if (job && job.heartbeatId) {
    clearInterval(job.heartbeatId);
    job.heartbeatId = null;
  }
}

async function sendJobHeartbeat(job) {
  if (!job || !job.serverJobId) return;
  const state = await getStoredState();
  const webhookUrl = state.webhookUrl;
  if (!webhookUrl) return;
  try {
    const apiBase = buildWebtaskApiBase(webhookUrl);
    const headers = buildAuthHeaders(state.webtaskApiKey);
    await fetch(`${apiBase}/heartbeat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        job_id: job.serverJobId,
        client_id: state.clientId,
        extend_seconds: 180
      })
    });
  } catch (error) {
    await addLog({
      time: Date.now(),
      task: job.task ? job.task.name : "heartbeat",
      success: false,
      message: `Heartbeat failed: ${error.message || "network error"}`
    });
  }
}

function scheduleWsReconnect() {
  clearWsReconnectTimer();
  const delay = Math.min(WS_RECONNECT_BASE_MS * Math.pow(2, wsReconnectAttempts), WS_RECONNECT_MAX_MS);
  wsReconnectAttempts += 1;
  wsReconnectTimer = setTimeout(() => {
    connectWebtaskSocket();
  }, delay);
}

async function connectWebtaskSocket() {
  if (typeof WebSocket === "undefined") {
    return;
  }
  const state = await getStoredState();
  if (state.protocol !== "webtask" || !state.webhookUrl) {
    if (wsClient) {
      try {
        wsClient.close();
      } catch (error) {
        // Ignore close errors
      }
      wsClient = null;
    }
    clearWsReconnectTimer();
    return;
  }

  if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const wsBase = toWsUrl(state.webhookUrl);
  if (!wsBase) {
    await updateConnection(false, "Invalid webhook URL");
    return;
  }
  const wsUrlObj = new URL(`${wsBase}/api/webtask/ws`);
  wsUrlObj.searchParams.set("client_id", state.clientId);
  if (state.webtaskApiKey) {
    wsUrlObj.searchParams.set("api_key", state.webtaskApiKey);
  }

  try {
    wsClient = new WebSocket(wsUrlObj.toString());
  } catch (error) {
    await updateConnection(false, error.message || "websocket error");
    scheduleWsReconnect();
    return;
  }

  wsClient.addEventListener("open", async () => {
    wsReconnectAttempts = 0;
    clearWsReconnectTimer();
    await updateConnection(true, "");
  });

  wsClient.addEventListener("message", async (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    if (payload.type === "task_available" && !currentJob) {
      handlePoll("ws");
    }
    if (payload.type === "ping" && wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify({ type: "pong", ts: Date.now() }));
    }
  });

  wsClient.addEventListener("close", async () => {
    wsClient = null;
    await updateConnection(false, "websocket disconnected");
    scheduleWsReconnect();
  });

  wsClient.addEventListener("error", async () => {
    await updateConnection(false, "websocket error");
  });
}

function buildUrl(template, data) {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (data && data[key] !== undefined && data[key] !== null) {
      return encodeURIComponent(String(data[key]));
    }
    return match;
  });
}

async function getTasks() {
  const state = await getStoredState();
  return state.tasks || [];
}

function normalizeUrl(url) {
  return url.split("#")[0].replace(/\/+$/, "");
}

async function refreshTabs(targetUrl, matchMode) {
  const tabs = await api.tabs.query({});
  let refreshedCount = 0;
  const normalizedTarget = normalizeUrl(targetUrl);

  for (const tab of tabs) {
    if (!tab.url) {
      continue;
    }
    const normalizedTab = normalizeUrl(tab.url);
    const shouldRefresh =
      matchMode === "prefix"
        ? normalizedTab.startsWith(normalizedTarget)
        : normalizedTab === normalizedTarget;
    if (shouldRefresh) {
      await api.tabs.reload(tab.id);
      refreshedCount += 1;
    }
  }

  await addLog({
    time: Date.now(),
    task: "refresh_tabs",
    success: true,
    message: `Refreshed ${refreshedCount} tab(s) for ${targetUrl}`
  });
}

function buildTaskMap(tasks) {
  return tasks.reduce((acc, task) => {
    if (task && task.name) {
      acc[task.name] = task;
    }
    return acc;
  }, {});
}

function validateTask(task) {
  if (!task || typeof task !== "object") {
    return "Invalid task";
  }
  if (!task.name || typeof task.name !== "string" || !task.name.trim()) {
    return "Task name is required";
  }
  if (!task.url || typeof task.url !== "string" || !task.url.trim()) {
    return "Task url is required";
  }
  const hasSteps = Array.isArray(task.steps) && task.steps.length > 0;
  const hasScriptString = typeof task.script === "string" && task.script.trim();
  const hasScriptArray = Array.isArray(task.script) && task.script.length > 0;
  const hasScript = hasScriptString || hasScriptArray;
  if (!hasSteps && !hasScript) {
    return "Task requires steps or script";
  }
  if (hasScriptArray) {
    for (const line of task.script) {
      if (typeof line !== "string") {
        return "Script lines must be strings";
      }
    }
  }
  if (hasSteps) {
    for (const step of task.steps) {
      if (!step || typeof step.action !== "string" || !step.action.trim()) {
        return "Each step requires an action";
      }
    }
  }
  if (task.timeout !== undefined) {
    const timeout = Number(task.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return "Task timeout must be a positive number";
    }
  }
  if (task.enabled !== undefined && typeof task.enabled !== "boolean") {
    return "Task enabled must be boolean";
  }
  return "";
}

function normalizeTask(task) {
  const normalized = { ...task };
  if (Array.isArray(normalized.script)) {
    normalized.script = normalized.script.join("\n");
  }
  return normalized;
}

function parseCooldownRangeMinutes(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const rangeMatch = raw.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (rangeMatch) {
    const left = Number(rangeMatch[1]);
    const right = Number(rangeMatch[2]);
    if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) {
      return null;
    }
    return {
      min: Math.min(left, right),
      max: Math.max(left, right)
    };
  }
  const single = Number(raw);
  if (!Number.isFinite(single) || single <= 0) {
    return null;
  }
  return { min: single, max: single };
}

function hasTaskTimer(task) {
  return !!(task && parseCooldownRangeMinutes(task.cooldownMinutes));
}

function randomIntBetween(min, max) {
  const start = Math.min(min, max);
  const end = Math.max(min, max);
  if (start === end) return start;
  return Math.floor(Math.random() * (end - start + 1)) + start;
}

function computeNextRunAt(task, baseTime) {
  const range = parseCooldownRangeMinutes(task && task.cooldownMinutes);
  if (!range) return 0;
  const timerMode = task && task.timerMode === "window" ? "window" : "exact";
  const minMs = Math.max(1000, Math.floor(range.min * 60 * 1000));
  const maxMs = Math.max(minMs, Math.floor(range.max * 60 * 1000));
  let delayMs = timerMode === "window" ? randomIntBetween(minMs, maxMs) : minMs;
  if (timerMode === "window") {
    const windowSeconds = Number(task.windowSeconds);
    if (Number.isFinite(windowSeconds) && windowSeconds > 0) {
      delayMs += randomIntBetween(0, Math.floor(windowSeconds * 1000));
    }
  }
  const base = Number.isFinite(baseTime) ? baseTime : Date.now();
  return base + delayMs;
}

async function ensureTaskNextRunAt(state, now) {
  const tasks = state.tasks || [];
  const taskStatus = { ...(state.taskStatus || {}) };
  let changed = false;
  for (const task of tasks) {
    if (task && task.enabled === false) {
      continue;
    }
    if (!hasTaskTimer(task)) {
      continue;
    }
    const current = taskStatus[task.name] || {};
    if (Number.isFinite(current.nextRunAt) && current.nextRunAt > 0) {
      continue;
    }
    let nextRunAt = now;
    if (Number.isFinite(current.lastRun) && current.lastRun > 0) {
      nextRunAt = computeNextRunAt(task, current.lastRun);
    }
    taskStatus[task.name] = {
      ...current,
      nextRunAt
    };
    changed = true;
  }
  if (changed) {
    await api.storage.local.set({ taskStatus });
  }
  return taskStatus;
}

async function runLocalScheduledTasks(state, source) {
  if (source === "ws" || currentJob) {
    return;
  }
  const tasks = state.tasks || [];
  const now = Date.now();
  const taskStatus = await ensureTaskNextRunAt(state, now);
  let candidate = null;
  let candidateNextRunAt = Number.POSITIVE_INFINITY;

  for (const task of tasks) {
    if (!task || task.enabled === false || !hasTaskTimer(task)) {
      continue;
    }
    const status = taskStatus[task.name] || {};
    const nextRunAt = Number(status.nextRunAt);
    if (!Number.isFinite(nextRunAt)) {
      continue;
    }
    if (nextRunAt <= now && nextRunAt < candidateNextRunAt) {
      candidate = task;
      candidateNextRunAt = nextRunAt;
    }
  }

  if (!candidate) {
    return;
  }

  await startTask(candidate.name, candidate.defaultData || {}, false, {
    triggerSource: "alarm"
  });
}

async function updateConnection(connected, lastError) {
  const state = await getStoredState();
  const next = {
    connected,
    lastError: lastError || "",
    lastCheck: Date.now()
  };
  await api.storage.local.set({ connection: next });
}

async function addLog(entry) {
  const state = await getStoredState();
  const logs = [entry, ...state.logs].slice(0, LOG_LIMIT);
  await api.storage.local.set({ logs });
}

async function updateTaskStatus(taskName, success, message, metadata) {
  const state = await getStoredState();
  const taskStatus = { ...state.taskStatus };
  const current = taskStatus[taskName] || {};
  const next = {
    ...current,
    lastRun: Date.now(),
    lastResult: success ? "success" : "fail",
    message: message || ""
  };
  const triggerSource = metadata && metadata.triggerSource;
  if (triggerSource) {
    next.lastTriggerSource = triggerSource;
  }
  const nextRunAt = metadata && metadata.nextRunAt;
  if (Number.isFinite(nextRunAt) && nextRunAt > 0) {
    next.nextRunAt = nextRunAt;
  } else {
    delete next.nextRunAt;
  }
  taskStatus[taskName] = {
    ...next
  };
  await api.storage.local.set({ taskStatus });
}

async function reportToWebhook(taskName, success, message, variables, jobId) {
  const state = await getStoredState();
  const webhookUrl = state.webhookUrl;
  if (!webhookUrl) {
    return;
  }
  const cleanVariables = {};
  if (variables && typeof variables === "object") {
    for (const [key, value] of Object.entries(variables)) {
      const lower = String(key).toLowerCase();
      if (lower === "api_key" || lower.includes("token") || lower.includes("password")) {
        continue;
      }
      cleanVariables[key] = value;
    }
  }
  try {
    const apiBase = buildWebtaskApiBase(webhookUrl);
    const headers = buildAuthHeaders(state.webtaskApiKey);
    await fetch(`${apiBase}/report`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        task: taskName,
        success,
        message,
        variables: cleanVariables,
        client_id: state.clientId,
        job_id: jobId || undefined
      })
    });
  } catch (error) {
    await updateConnection(false, error.message || "report failed");
  }
}

async function finishJob(job, success, message, variables, keepOpen) {
  if (!job || !currentJob || job.id !== currentJob.id) {
    return;
  }
  clearTimeout(job.timeoutId);
  clearJobHeartbeat(job);
  currentJob = null;
  await updateTaskStatus(job.task.name, success, message, {
    triggerSource: job.triggerSource,
    nextRunAt: computeNextRunAt(job.task, Date.now())
  });
  await addLog({
    time: Date.now(),
    task: job.task.name,
    success,
    message: message || ""
  });
  await reportToWebhook(job.task.name, success, message, variables, job.serverJobId || "");
  if (!keepOpen) {
    try {
      await api.tabs.remove(job.tabId);
    } catch (error) {
      // Ignore tab close errors
    }
  }
}

async function startTask(taskName, data, manualTrigger, options) {
  const taskOptions = options || {};
  const triggerSource =
    taskOptions.triggerSource ||
    (manualTrigger ? "manual" : "remote");
  if (currentJob) {
    return { ok: false, message: "busy" };
  }
  const tasks = await getTasks();
  const taskMap = buildTaskMap(tasks);
  const task = taskMap[taskName];
  if (!task) {
    await updateTaskStatus(taskName, false, "Unknown task");
    await addLog({ time: Date.now(), task: taskName, success: false, message: "Unknown task" });
    await reportToWebhook(taskName, false, "Unknown task", {}, "");
    return { ok: false, message: "unknown task" };
  }
  if (task.enabled === false) {
    await updateTaskStatus(taskName, false, "Task disabled");
    await addLog({ time: Date.now(), task: taskName, success: false, message: "Task disabled" });
    await reportToWebhook(taskName, false, "Task disabled", {}, "");
    return { ok: false, message: "task disabled" };
  }

  const targetUrl = buildUrl(task.url, data || {});
  const tab = await api.tabs.create({ url: targetUrl, active: false });
  const job = {
    id: `${task.name}-${Date.now()}`,
    tabId: tab.id,
    task,
    data: data || {},
    stepIndex: 0,
    variables: {},
    state: "waiting",
    timeoutId: null,
    heartbeatId: null,
    manualTrigger: !!manualTrigger,
    serverJobId: taskOptions.jobId || "",
    triggerSource
  };

  const state = await getStoredState();
  if (state.webtaskApiKey) {
    job.variables.api_key = state.webtaskApiKey;
    job.variables.API_KEY = state.webtaskApiKey;
  }

  const timeoutMs = Number.isFinite(Number(task.timeout)) ? Number(task.timeout) : TASK_TIMEOUT_MS;
  job.timeoutId = setTimeout(() => {
    finishJob(job, false, "Task timeout", job.variables, false);
  }, timeoutMs);

  if (job.serverJobId) {
    job.heartbeatId = setInterval(() => {
      sendJobHeartbeat(job);
    }, HEARTBEAT_INTERVAL_MS);
  }

  currentJob = job;
  return { ok: true };
}

async function handlePoll(source) {
  const state = await getStoredState();
  await runLocalScheduledTasks(state, source);
  const webhookUrl = state.webhookUrl;
  if (!webhookUrl || (state.protocol === "webtask" && currentJob)) {
    return;
  }
  try {
    if (state.protocol === "shuaxin") {
      const baseUrl = webhookUrl.replace(/\/+$/, "");
      const response = await fetch(`${baseUrl}/poll?since=${state.shuaxinCursor}`, {
        cache: "no-store"
      });
      if (!response.ok) {
        await updateConnection(false, `HTTP ${response.status}`);
        return;
      }
      const payload = await response.json();
      await updateConnection(true, "");
      if (!payload || payload.type !== "refresh" || !payload.id) {
        return;
      }
      if (payload.id !== state.shuaxinCursor) {
        await api.storage.local.set({ shuaxinCursor: payload.id });
      }
      await refreshTabs(payload.url, payload.match || "exact");
      return;
    }

    const apiBase = buildWebtaskApiBase(webhookUrl);
    const headers = buildAuthHeaders(state.webtaskApiKey);
    const pendingUrl = new URL(`${apiBase}/pending`);
    pendingUrl.searchParams.set("client_id", state.clientId);
    const response = await fetch(pendingUrl.toString(), { cache: "no-store", headers });
    if (!response.ok) {
      await updateConnection(false, `HTTP ${response.status}`);
      return;
    }
    const payload = await response.json();
    await updateConnection(true, "");
    if (!payload || !payload.task) {
      return;
    }
    const started = await startTask(payload.task, payload.data || {}, false, {
      jobId: payload.job_id || "",
      triggerSource: "remote"
    });
    if (!started.ok && source === "ws") {
      await addLog({
        time: Date.now(),
        task: payload.task,
        success: false,
        message: `WS dispatch skipped: ${started.message || "unknown"}`
      });
    }
  } catch (error) {
    await updateConnection(false, error.message || "network error");
  }
}

async function runJobSteps(job) {
  if (!job) {
    return;
  }
  job.state = "running";
  try {
    const messagePayload = {
      type: job.task.script ? "runScript" : "runTask",
      taskName: job.task.name,
      steps: job.task.steps,
      script: job.task.script || "",
      data: job.data,
      startIndex: job.stepIndex,
      variables: job.variables
    };

    let response = null;
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await api.tabs.executeScript(job.tabId, { file: "content.js" });
        response = await api.tabs.sendMessage(job.tabId, messagePayload);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const msg = String((error && error.message) || "").toLowerCase();
        const isNoReceiver =
          msg.includes("receiving end does not exist") ||
          msg.includes("could not establish connection");
        if (!isNoReceiver || attempt === 4) {
          throw error;
        }
        await sleep(800);
      }
    }

    if (lastError) {
      throw lastError;
    }

    if (!response) {
      await finishJob(job, false, "No response", job.variables, false);
      return;
    }

    if (response.status === "reloading") {
      return;
    }

    if (response.success) {
      await finishJob(job, true, response.message || "ok", response.variables || job.variables, false);
    } else {
      await finishJob(
        job,
        false,
        response.message || "Task failed",
        response.variables || job.variables,
        !!response.keepOpen
      );
    }
  } catch (error) {
    await finishJob(job, false, error.message || "Task error", job.variables, false);
  }
}

api.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "httpRequest") {
    return (async () => {
      const url = message.url || "";
      if (!url || typeof url !== "string") {
        return { ok: false, status: 0, error: "Invalid url" };
      }
      const method = (message.method || "GET").toUpperCase();
      const headers = message.headers && typeof message.headers === "object" ? { ...message.headers } : {};
      let body = message.body;
      if (body && typeof body === "object" && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
        body = JSON.stringify(body);
        if (!headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }
      }
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutMs = Number.isFinite(Number(message.timeoutMs)) ? Number(message.timeoutMs) : 0;
      let timeoutId = null;
      if (controller && timeoutMs > 0) {
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      }
      try {
        const response = await fetch(url, {
          method,
          headers,
          body,
          signal: controller ? controller.signal : undefined
        });
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        const responseType = message.responseType || "json";
        let data = null;
        if (responseType === "text") {
          data = await response.text();
        } else if (responseType === "raw") {
          data = null;
        } else {
          try {
            data = await response.json();
          } catch (error) {
            data = await response.text();
          }
        }
        return {
          ok: response.ok,
          status: response.status,
          data,
          headers: responseHeaders
        };
      } catch (error) {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        return { ok: false, status: 0, error: error.message || "request failed" };
      }
    })();
  }

  if (message.type === "getState") {
    return (async () => {
      const state = await getStoredState();
      const taskStatus = await ensureTaskNextRunAt(state, Date.now());
      return {
        webhookUrl: state.webhookUrl,
        webtaskApiKey: state.webtaskApiKey,
        connection: state.connection,
        taskStatus,
        logs: state.logs,
        pollIntervalMinutes: state.pollIntervalMinutes,
        protocol: state.protocol,
        clientId: state.clientId,
        tasks: (state.tasks || []).map((task) => ({
          name: task.name,
          label: task.label,
          url: task.url,
          steps: task.steps || [],
          script: task.script || "",
          timeout: task.timeout,
          enabled: task.enabled !== false,
          defaultData: task.defaultData || {},
          timerMode: task.timerMode,
          cooldownMinutes: task.cooldownMinutes,
          windowSeconds: task.windowSeconds
        }))
      };
    })();
  }

  if (message.type === "setWebhookUrl") {
    return (async () => {
      await api.storage.local.set({ webhookUrl: message.webhookUrl || "" });
      await api.storage.local.set({ shuaxinCursor: "0" });
      await connectWebtaskSocket();
      return { ok: true };
    })();
  }

  if (message.type === "testConnection") {
    return (async () => {
      const state = await getStoredState();
      const webhookUrl = state.webhookUrl;
      if (!webhookUrl) {
        return { ok: false, message: "Webhook 地址为空" };
      }
      try {
        const apiBase = buildWebtaskApiBase(webhookUrl);
        const headers = buildAuthHeaders(state.webtaskApiKey);
        const testUrl = new URL(`${apiBase}/pending`);
        testUrl.searchParams.set("client_id", state.clientId);
        const response = await fetch(testUrl.toString(), { cache: "no-store", headers });
        if (!response.ok) {
          await updateConnection(false, `HTTP ${response.status}`);
          return { ok: false, message: `HTTP ${response.status}` };
        }
        await updateConnection(true, "");
        connectWebtaskSocket();
        return { ok: true };
      } catch (error) {
        await updateConnection(false, error.message || "network error");
        return { ok: false, message: error.message || "network error" };
      }
    })();
  }

  if (message.type === "setWebtaskApiKey") {
    return (async () => {
      await api.storage.local.set({ webtaskApiKey: message.webtaskApiKey || "" });
      await connectWebtaskSocket();
      return { ok: true };
    })();
  }

  if (message.type === "setProtocol") {
    return (async () => {
      const protocol = message.protocol === "shuaxin" ? "shuaxin" : "webtask";
      await api.storage.local.set({ protocol, shuaxinCursor: "0" });
      await connectWebtaskSocket();
      return { ok: true };
    })();
  }

  if (message.type === "setPollInterval") {
    return (async () => {
      const minutes = Number(message.pollIntervalMinutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { ok: false, message: "Invalid interval" };
      }
      await api.storage.local.set({ pollIntervalMinutes: minutes });
      await schedulePolling(minutes);
      return { ok: true };
    })();
  }

  if (message.type === "importTask") {
    return (async () => {
      const task = normalizeTask(message.task);
      const error = validateTask(task);
      if (error) {
        return { ok: false, message: error };
      }
      const tasks = await getTasks();
      const replaceTaskName =
        typeof message.replaceTaskName === "string" ? message.replaceTaskName.trim() : "";
      const exists = tasks.find(
        (item) => item.name === task.name && item.name !== replaceTaskName
      );
      if (exists && !message.allowOverwrite) {
        return { ok: false, message: "Task name already exists" };
      }
      const normalizedTask = {
        ...task,
        enabled: task.enabled !== false
      };
      const nextTasks = tasks.filter(
        (item) => item.name !== task.name && item.name !== replaceTaskName
      );
      nextTasks.push(normalizedTask);
      const state = await getStoredState();
      const taskStatus = { ...(state.taskStatus || {}) };
      if (hasTaskTimer(normalizedTask) && normalizedTask.enabled !== false) {
        const currentStatus = taskStatus[normalizedTask.name] || {};
        taskStatus[normalizedTask.name] = {
          ...currentStatus,
          nextRunAt: Date.now()
        };
      }
      if (replaceTaskName && replaceTaskName !== normalizedTask.name) {
        delete taskStatus[replaceTaskName];
      }
      await api.storage.local.set({ tasks: nextTasks, taskStatus });
      return { ok: true };
    })();
  }

  if (message.type === "deleteTask") {
    return (async () => {
      const name = message.taskName;
      if (!name) {
        return { ok: false, message: "Task name is required" };
      }
      const tasks = await getTasks();
      const nextTasks = tasks.filter((item) => item.name !== name);
      const state = await getStoredState();
      const taskStatus = { ...(state.taskStatus || {}) };
      delete taskStatus[name];
      await api.storage.local.set({ tasks: nextTasks, taskStatus });
      return { ok: true };
    })();
  }

  if (message.type === "setTaskEnabled") {
    return (async () => {
      const name = message.taskName;
      const enabled = !!message.enabled;
      if (!name) {
        return { ok: false, message: "Task name is required" };
      }
      const tasks = await getTasks();
      const targetTask = tasks.find((task) => task.name === name) || null;
      const nextTasks = tasks.map((task) =>
        task.name === name ? { ...task, enabled } : task
      );
      const state = await getStoredState();
      const taskStatus = { ...(state.taskStatus || {}) };
      const current = taskStatus[name] || {};
      if (enabled && targetTask && hasTaskTimer(targetTask)) {
        taskStatus[name] = {
          ...current,
          nextRunAt: Number.isFinite(current.nextRunAt) && current.nextRunAt > 0 ? current.nextRunAt : Date.now()
        };
      } else if (taskStatus[name]) {
        taskStatus[name] = {
          ...current,
          nextRunAt: 0
        };
      }
      await api.storage.local.set({ tasks: nextTasks, taskStatus });
      return { ok: true };
    })();
  }

  if (message.type === "taskLog") {
    return (async () => {
      if (!message.taskName || !message.message) {
        return { ok: false };
      }
      await addLog({
        time: Date.now(),
        task: message.taskName,
        success: true,
        message: message.message
      });
      return { ok: true };
    })();
  }

  if (message.type === "clearLogs") {
    return (async () => {
      await api.storage.local.set({ logs: [] });
      return { ok: true };
    })();
  }

  if (message.type === "triggerTask") {
    return (async () => {
      const result = await startTask(message.taskName, message.data || {}, true, {
        triggerSource: "manual"
      });
      return result;
    })();
  }

  if (message.type === "taskReload" && sender && sender.tab) {
    return (async () => {
      const job = currentJob;
      if (!job || job.tabId !== sender.tab.id) {
        return { ok: false };
      }
      job.stepIndex = message.nextIndex || 0;
      job.variables = message.variables || job.variables;
      job.state = "waiting";
      await api.tabs.reload(job.tabId);
      return { ok: true };
    })();
  }

  return undefined;
});

api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!currentJob || currentJob.tabId !== tabId) {
    return;
  }
  if (changeInfo.status === "complete" && currentJob.state === "waiting") {
    runJobSteps(currentJob);
  }
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === "webtask_poll") {
    handlePoll();
  }
});

api.runtime.onInstalled.addListener(() => {
  (async () => {
    await ensureDefaults();
    const state = await getStoredState();
    if (!state.tasks || state.tasks.length === 0) {
      await api.storage.local.set({ tasks: DEFAULT_TASKS });
    }
    await schedulePolling(state.pollIntervalMinutes);
    await connectWebtaskSocket();
    await handlePoll("startup");
  })();
});

api.runtime.onStartup.addListener(() => {
  (async () => {
    await ensureDefaults();
    const state = await getStoredState();
    await schedulePolling(state.pollIntervalMinutes);
    await connectWebtaskSocket();
    await handlePoll("startup");
  })();
});

(async () => {
  await ensureDefaults();
  const state = await getStoredState();
  await schedulePolling(state.pollIntervalMinutes);
  await connectWebtaskSocket();
  await handlePoll("startup");
})();
