const api = typeof browser !== "undefined" ? browser : chrome;

const {
  DEFAULT_WEBHOOK_URL,
  DEFAULT_POLL_INTERVAL_MINUTES,
  TASK_TIMEOUT_MS,
  LOG_LIMIT,
  DEFAULT_PROTOCOL,
  WS_RECONNECT_BASE_MS,
  WS_RECONNECT_MAX_MS,
  HEARTBEAT_INTERVAL_MS,
  DEFAULT_TASKS
} = WebTaskBackgroundDefaults;

const {
  sleep,
  toWsUrl,
  buildWebtaskApiBase,
  buildAuthHeaders,
  buildUrl,
  normalizeUrl,
  isInjectableUrl,
  buildTaskMap,
  hasTaskTimer,
  computeNextRunAt
} = WebTaskBackgroundUtils;

const {
  STORAGE_KEYS,
  normalizeStoredState,
  buildDefaultStorageUpdates
} = WebTaskStorageHelpers;

const {
  buildSafeLogEntry,
  buildNextTaskStatus
} = WebTaskStatusHelpers;

const {
  buildWebtaskWsUrl,
  buildHeartbeatBody,
  buildReportBody,
  buildPendingUrl,
  buildShuaxinPollUrl,
  isValidShuaxinRefreshPayload,
  isValidPendingTaskPayload,
  buildRemoteStartOptions
} = WebTaskRemoteHelpers;

const {
  normalizeHttpRequest,
  extractResponseHeaders,
  readResponseData
} = WebTaskHttpHelpers;

const { buildStateResponse } = WebTaskStateResponse;

const {
  buildImportTaskMutation,
  buildDeleteTaskMutation,
  buildSetTaskEnabledMutation
} = WebTaskMutations;

const {
  resolveTriggerSource,
  createJob,
  attachApiKeyVariables,
  buildContentMessagePayload
} = WebTaskJobHelpers;

const {
  ensureTaskNextRunAtInStatus,
  selectDueScheduledTask
} = WebTaskSchedulerHelpers;

const {
  getTabUrl,
  shouldRefreshTab,
  isMissingHostPermissionError,
  isNoReceiverError
} = WebTaskTabHelpers;

const {
  buildResponseResult,
  buildErrorResult,
  applyFailureMetadata
} = WebTaskRunResultHelpers;

const {
  shouldCloseWebtaskSocket,
  hasActiveWebSocket,
  parseWebSocketPayload,
  shouldPollForWebSocketPayload,
  shouldPongWebSocketPayload,
  buildPongPayload
} = WebTaskWebSocketHelpers;

const STORAGE_DEFAULTS = {
  DEFAULT_WEBHOOK_URL,
  DEFAULT_POLL_INTERVAL_MINUTES,
  DEFAULT_PROTOCOL
};

let currentJob = null;
let queuedJobs = [];
let wsClient = null;
let wsReconnectTimer = null;
let wsReconnectAttempts = 0;

const CONTENT_SCRIPT_FILE = "content.js";
const CONTENT_SCRIPT_RESET_CODE = "window.__WEBTASK_INJECTED__ = false; true;";

async function getStoredState() {
  const data = await api.storage.local.get(STORAGE_KEYS);
  return normalizeStoredState(data, STORAGE_DEFAULTS);
}

async function ensureDefaults() {
  const data = await api.storage.local.get(STORAGE_KEYS);
  const updates = buildDefaultStorageUpdates(data, STORAGE_DEFAULTS);
  if (Object.keys(updates).length) {
    await api.storage.local.set(updates);
  }
}

async function schedulePolling(intervalMinutes) {
  const minutes = intervalMinutes || DEFAULT_POLL_INTERVAL_MINUTES;
  await api.alarms.clear("webtask_poll");
  api.alarms.create("webtask_poll", { periodInMinutes: minutes });
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
      body: JSON.stringify(buildHeartbeatBody(job, state.clientId))
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
  if (shouldCloseWebtaskSocket(state)) {
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

  if (hasActiveWebSocket(wsClient, WebSocket)) {
    return;
  }

  const wsUrl = buildWebtaskWsUrl(state.webhookUrl, state.clientId, state.webtaskApiKey, toWsUrl);
  if (!wsUrl) {
    await updateConnection(false, "Invalid webhook URL");
    return;
  }

  try {
    wsClient = new WebSocket(wsUrl);
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
    const payload = parseWebSocketPayload(event.data);
    if (!payload) return;
    if (shouldPollForWebSocketPayload(payload, !!currentJob)) {
      handlePoll("ws");
    }
    if (shouldPongWebSocketPayload(payload, wsClient, WebSocket)) {
      wsClient.send(buildPongPayload(Date.now()));
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

async function getTasks() {
  const state = await getStoredState();
  return state.tasks || [];
}

async function waitForInjectableTab(tabId, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let lastUrl = "";
  while (Date.now() < deadline) {
    try {
      const tabInfo = await api.tabs.get(tabId);
      const url = getTabUrl(tabInfo, "");
      lastUrl = url || lastUrl;
      if (isInjectableUrl(url)) {
        return { ok: true, url };
      }
    } catch (error) {
      // Ignore transient tab lookup errors
    }
    await sleep(400);
  }
  return { ok: false, url: lastUrl || "unknown" };
}

async function pingContentScript(tabId) {
  const response = await api.tabs.sendMessage(tabId, { type: "webtaskPing" });
  return !!(response && response.ok);
}

async function resetContentScriptGuard(tabId) {
  await api.tabs.executeScript(tabId, { code: CONTENT_SCRIPT_RESET_CODE });
}

async function ensureContentScript(tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const tabReady = await waitForInjectableTab(tabId, attempt === 0 ? 7000 : 10000);
      if (!tabReady.ok) {
        throw new Error(`Tab not injectable yet: ${tabReady.url}`);
      }

      try {
        if (await pingContentScript(tabId)) {
          return;
        }
      } catch (error) {
        if (!isNoReceiverError(error)) {
          throw error;
        }
        lastError = error;
      }

      if (attempt > 0) {
        await resetContentScriptGuard(tabId);
      }
      await api.tabs.executeScript(tabId, { file: CONTENT_SCRIPT_FILE });
      await sleep(150);
      if (await pingContentScript(tabId)) {
        return;
      }
      lastError = new Error("Content script did not answer ping");
    } catch (error) {
      lastError = error;
      if (isMissingHostPermissionError(error)) {
        const tabReady = await waitForInjectableTab(tabId, 10000);
        if (tabReady.ok && attempt < 4) {
          await sleep(800);
          continue;
        }
        throw new Error(`Missing host permission for tab: ${tabReady.url}`);
      }
      if (!isNoReceiverError(error) && error.message !== "Content script did not answer ping") {
        throw error;
      }
    }
    await sleep(800);
  }

  let url = "unknown";
  try {
    const tabInfo = await api.tabs.get(tabId);
    url = getTabUrl(tabInfo, url);
  } catch (error) {
    // Keep the original content-script error below.
  }
  const detail = lastError && lastError.message ? ` ${lastError.message}` : "";
  throw new Error(`Content script is not responding in tab: ${url}.${detail}`);
}

async function refreshTabs(targetUrl, matchMode) {
  const tabs = await api.tabs.query({});
  let refreshedCount = 0;
  for (const tab of tabs) {
    if (shouldRefreshTab(tab.url, targetUrl, matchMode, normalizeUrl)) {
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

const redactText = WebTaskSecurity.redactText;
const redactVariables = WebTaskSecurity.redactVariables;

const validateTask = (task) => WebTaskValidation.validateTask(task);
const normalizeTask = WebTaskValidation.normalizeTask;

async function ensureTaskNextRunAt(state, now) {
  const tasks = state.tasks || [];
  const taskStatus = { ...(state.taskStatus || {}) };
  const changed = ensureTaskNextRunAtInStatus(
    tasks,
    taskStatus,
    now,
    currentJob,
    TASK_TIMEOUT_MS,
    hasTaskTimer,
    computeNextRunAt
  );
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
  const candidate = selectDueScheduledTask(tasks, taskStatus, now, hasTaskTimer);
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
    lastError: redactText(lastError || ""),
    lastCheck: Date.now()
  };
  await api.storage.local.set({ connection: next });
}

async function addLog(entry) {
  const state = await getStoredState();
  const logs = [buildSafeLogEntry(entry, redactText), ...state.logs].slice(0, LOG_LIMIT);
  await api.storage.local.set({ logs });
}

async function updateTaskStatus(taskName, success, message, metadata) {
  const state = await getStoredState();
  const taskStatus = { ...state.taskStatus };
  const current = taskStatus[taskName] || {};
  taskStatus[taskName] = buildNextTaskStatus(current, success, message, metadata, Date.now(), redactText);
  await api.storage.local.set({ taskStatus });
}

async function reportToWebhook(taskName, success, message, variables, jobId, runId) {
  const state = await getStoredState();
  const webhookUrl = state.webhookUrl;
  if (!webhookUrl) {
    return;
  }
  const cleanVariables = redactVariables(variables);
  const cleanMessage = redactText(message || "");
  try {
    const apiBase = buildWebtaskApiBase(webhookUrl);
    const headers = buildAuthHeaders(state.webtaskApiKey);
    await fetch(`${apiBase}/report`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildReportBody(taskName, success, cleanMessage, cleanVariables, state.clientId, jobId, runId))
    });
  } catch (error) {
    await updateConnection(false, error.message || "report failed");
  }
}

async function finishJob(job, success, message, variables, keepOpen, nextRunAtOverride) {
  if (!job || !currentJob || job.id !== currentJob.id) {
    return;
  }
  clearTimeout(job.timeoutId);
  clearJobHeartbeat(job);
  currentJob = null;
  const nextRunAt = Number(nextRunAtOverride);
  await updateTaskStatus(job.task.name, success, message, {
    triggerSource: job.triggerSource,
    nextRunAt: Number.isFinite(nextRunAt) && nextRunAt > 0 ? nextRunAt : computeNextRunAt(job.task, Date.now()),
    runId: job.id,
    failedStepIndex: job.failedStepIndex,
    failedStepAction: job.failedStepAction,
    diagnostics: job.diagnostics
  });
  await addLog({
    time: Date.now(),
    task: job.task.name,
    success,
    message: message || "",
    runId: job.id,
    diagnostics: success ? undefined : job.diagnostics
  });
  await reportToWebhook(job.task.name, success, message, variables, job.serverJobId || "", job.id);
  if (!keepOpen) {
    try {
      await api.tabs.remove(job.tabId);
    } catch (error) {
      // Ignore tab close errors
    }
  }
  drainTaskQueue().catch((error) => {
    addLog({ time: Date.now(), task: job.task.name, success: false, message: error && error.message ? error.message : "Queue drain failed" });
  });
}

function enqueueTask(taskName, data, manualTrigger, options, triggerSource) {
  queuedJobs.push({ taskName, data, manualTrigger, options, triggerSource, queuedAt: Date.now() });
}

async function drainTaskQueue() {
  if (currentJob || !queuedJobs.length) {
    return;
  }
  const next = queuedJobs.shift();
  await startTask(next.taskName, next.data, next.manualTrigger, next.options, true);
}

async function stopCurrentJob(reason, keepTabOpen) {
  if (!currentJob) {
    return { ok: false, message: "no running task" };
  }
  const job = currentJob;
  await finishJob(job, false, reason || "Task stopped", job.variables, keepTabOpen !== false);
  return { ok: true };
}

async function startTask(taskName, data, manualTrigger, options, fromQueue) {
  const triggerSource = resolveTriggerSource(manualTrigger, options);
  if (currentJob) {
    try {
      await api.tabs.get(currentJob.tabId);
      if (!fromQueue) {
        enqueueTask(taskName, data, manualTrigger, options, triggerSource);
        await updateTaskStatus(taskName, "queued", "Task queued", { triggerSource });
        await addLog({ time: Date.now(), task: taskName, success: true, message: "Task queued" });
        return { ok: true, queued: true };
      }
      return { ok: false, message: "busy" };
    } catch (error) {
      await stopCurrentJob("Recovered stale task state", true);
    }
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
  const tab = await api.tabs.create({ url: targetUrl, active: task.openInBackground === true ? false : true });
  const job = createJob(task, tab.id, data, manualTrigger, options, triggerSource, Date.now());

  const state = await getStoredState();
  attachApiKeyVariables(job, state.webtaskApiKey);

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
  await updateTaskStatus(task.name, "running", "Task started", {
    triggerSource,
    runId: job.id
  });
  await addLog({
    time: Date.now(),
    task: task.name,
    success: true,
    message: "Task started",
    runId: job.id
  });
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
      const response = await fetch(buildShuaxinPollUrl(webhookUrl, state.shuaxinCursor), {
        cache: "no-store"
      });
      if (!response.ok) {
        await updateConnection(false, `HTTP ${response.status}`);
        return;
      }
      const payload = await response.json();
      await updateConnection(true, "");
      if (!isValidShuaxinRefreshPayload(payload)) {
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
    const response = await fetch(buildPendingUrl(apiBase, state.clientId), { cache: "no-store", headers });
    if (!response.ok) {
      await updateConnection(false, `HTTP ${response.status}`);
      return;
    }
    const payload = await response.json();
    await updateConnection(true, "");
    if (!isValidPendingTaskPayload(payload)) {
      return;
    }
    const started = await startTask(payload.task, payload.data || {}, false, buildRemoteStartOptions(payload));
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
    const messagePayload = buildContentMessagePayload(job);

    let response = null;
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await ensureContentScript(job.tabId);
        response = await api.tabs.sendMessage(job.tabId, messagePayload);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (isMissingHostPermissionError(error)) {
          const tabReady = await waitForInjectableTab(job.tabId, 10000);
          if (tabReady.ok && attempt < 4) {
            await sleep(800);
            continue;
          }
          throw new Error(`Missing host permission for tab: ${tabReady.url}`);
        }
        if (!isNoReceiverError(error) || attempt === 4) {
          throw error;
        }
        await sleep(800);
      }
    }

    if (lastError) {
      throw lastError;
    }

    const result = buildResponseResult(job, response);
    if (!result.shouldFinish) {
      return;
    }
    applyFailureMetadata(job, result);
    await finishJob(job, result.success, result.message, result.variables, result.keepOpen, result.nextRunAt);
  } catch (error) {
    const result = buildErrorResult(job, error);
    await finishJob(job, result.success, result.message, result.variables, result.keepOpen, result.nextRunAt);
  }
}

api.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "httpRequest") {
    return (async () => {
      const request = normalizeHttpRequest(message);
      if (!request.ok) {
        return { ok: false, status: 0, error: request.error };
      }
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      let timeoutId = null;
      if (controller && request.timeoutMs > 0) {
        timeoutId = setTimeout(() => controller.abort(), request.timeoutMs);
      }
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller ? controller.signal : undefined
        });
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        return {
          ok: response.ok,
          status: response.status,
          data: await readResponseData(response, request.responseType),
          headers: extractResponseHeaders(response)
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
      return buildStateResponse(state, taskStatus);
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
        const response = await fetch(buildPendingUrl(apiBase, state.clientId), { cache: "no-store", headers });
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
      const state = await getStoredState();
      const mutation = buildImportTaskMutation(tasks, state.taskStatus, task, replaceTaskName, hasTaskTimer, Date.now());
      await api.storage.local.set(mutation);
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
      const state = await getStoredState();
      await api.storage.local.set(buildDeleteTaskMutation(tasks, state.taskStatus, name));
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
      const state = await getStoredState();
      await api.storage.local.set(buildSetTaskEnabledMutation(tasks, state.taskStatus, name, enabled, hasTaskTimer, Date.now()));
      return { ok: true };
    })();
  }

  if (message.type === "taskLog") {
    return (async () => {
      if (!message.taskName || !message.message) {
        return { ok: false };
      }
      const runId = message.runId || (currentJob && currentJob.task.name === message.taskName ? currentJob.id : "");
      await addLog({
        time: Date.now(),
        task: message.taskName,
        success: true,
        message: message.message,
        runId
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

  if (message.type === "stopCurrentJob") {
    return stopCurrentJob(message.reason || "Task stopped manually", true);
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

  if (message.type === "taskNavigate" && sender && sender.tab) {
    return (async () => {
      const job = currentJob;
      if (!job || job.tabId !== sender.tab.id) {
        return { ok: false };
      }
      const rawUrl = String(message.url || "").trim();
      if (!rawUrl) {
        return { ok: false, message: "Navigation URL is required" };
      }
      let nextUrl = rawUrl;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) {
        try {
          const tabInfo = await api.tabs.get(job.tabId);
          nextUrl = new URL(rawUrl, getTabUrl(tabInfo, job.task.url) || job.task.url).toString();
        } catch (error) {
          nextUrl = rawUrl;
        }
      }
      job.stepIndex = message.nextIndex || 0;
      job.variables = message.variables || job.variables;
      job.state = "waiting";
      await api.tabs.update(job.tabId, { url: nextUrl });
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

api.tabs.onRemoved.addListener((tabId) => {
  if (!currentJob || currentJob.tabId !== tabId) {
    return;
  }
  stopCurrentJob("Task stopped: tab closed", true);
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
