const api = typeof browser !== "undefined" ? browser : chrome;

const DEFAULT_WEBHOOK_URL = "http://localhost:3000";
const DEFAULT_POLL_INTERVAL_MINUTES = 0.25;
const TASK_TIMEOUT_MS = 60000;
const LOG_LIMIT = 10;
const DEFAULT_PROTOCOL = "webtask";

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

async function getStoredState() {
  const data = await api.storage.local.get([
    "webhookUrl",
    "connection",
    "taskStatus",
    "logs",
    "pollIntervalMinutes",
    "tasks",
    "protocol",
    "shuaxinCursor"
  ]);
  return {
    webhookUrl: data.webhookUrl || DEFAULT_WEBHOOK_URL,
    connection: data.connection || { connected: false, lastError: "", lastCheck: 0 },
    taskStatus: data.taskStatus || {},
    logs: data.logs || [],
    pollIntervalMinutes: data.pollIntervalMinutes || DEFAULT_POLL_INTERVAL_MINUTES,
    tasks: data.tasks || [],
    protocol: data.protocol || DEFAULT_PROTOCOL,
    shuaxinCursor: data.shuaxinCursor || "0"
  };
}

async function ensureDefaults() {
  const data = await api.storage.local.get([
    "webhookUrl",
    "connection",
    "taskStatus",
    "logs",
    "pollIntervalMinutes",
    "tasks",
    "protocol",
    "shuaxinCursor"
  ]);
  const updates = {};
  if (!data.webhookUrl) {
    updates.webhookUrl = DEFAULT_WEBHOOK_URL;
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
  if (Object.keys(updates).length) {
    await api.storage.local.set(updates);
  }
}

async function schedulePolling(intervalMinutes) {
  const minutes = intervalMinutes || DEFAULT_POLL_INTERVAL_MINUTES;
  await api.alarms.clear("webtask_poll");
  api.alarms.create("webtask_poll", { periodInMinutes: minutes });
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
  const hasScript = typeof task.script === "string" && task.script.trim();
  if (!hasSteps && !hasScript) {
    return "Task requires steps or script";
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

async function updateTaskStatus(taskName, success, message) {
  const state = await getStoredState();
  const taskStatus = { ...state.taskStatus };
  taskStatus[taskName] = {
    lastRun: Date.now(),
    lastResult: success ? "success" : "fail",
    message: message || ""
  };
  await api.storage.local.set({ taskStatus });
}

async function reportToWebhook(taskName, success, message, variables) {
  const state = await getStoredState();
  const webhookUrl = state.webhookUrl;
  if (!webhookUrl) {
    return;
  }
  try {
    const baseUrl = webhookUrl.replace(/\/+$/, "");
    const apiBase = baseUrl.endsWith("/api/webtask") ? baseUrl : `${baseUrl}/api/webtask`;
    await fetch(`${apiBase}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: taskName, success, message, variables: variables || {} })
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
  currentJob = null;
  await updateTaskStatus(job.task.name, success, message);
  await addLog({
    time: Date.now(),
    task: job.task.name,
    success,
    message: message || ""
  });
  await reportToWebhook(job.task.name, success, message, variables);
  if (!keepOpen) {
    try {
      await api.tabs.remove(job.tabId);
    } catch (error) {
      // Ignore tab close errors
    }
  }
}

async function startTask(taskName, data, manualTrigger) {
  if (currentJob) {
    return { ok: false, message: "busy" };
  }
  const tasks = await getTasks();
  const taskMap = buildTaskMap(tasks);
  const task = taskMap[taskName];
  if (!task) {
    await updateTaskStatus(taskName, false, "Unknown task");
    await addLog({ time: Date.now(), task: taskName, success: false, message: "Unknown task" });
    await reportToWebhook(taskName, false, "Unknown task", {});
    return { ok: false, message: "unknown task" };
  }
  if (task.enabled === false) {
    await updateTaskStatus(taskName, false, "Task disabled");
    await addLog({ time: Date.now(), task: taskName, success: false, message: "Task disabled" });
    await reportToWebhook(taskName, false, "Task disabled", {});
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
    manualTrigger: !!manualTrigger
  };

  const timeoutMs = Number.isFinite(Number(task.timeout)) ? Number(task.timeout) : TASK_TIMEOUT_MS;
  job.timeoutId = setTimeout(() => {
    finishJob(job, false, "Task timeout", job.variables, false);
  }, timeoutMs);

  currentJob = job;
  return { ok: true };
}

async function handlePoll() {
  const state = await getStoredState();
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

    const baseUrl = webhookUrl.replace(/\/+$/, "");
    const apiBase = baseUrl.endsWith("/api/webtask") ? baseUrl : `${baseUrl}/api/webtask`;
    const response = await fetch(`${apiBase}/pending`, { cache: "no-store" });
    if (!response.ok) {
      await updateConnection(false, `HTTP ${response.status}`);
      return;
    }
    const payload = await response.json();
    await updateConnection(true, "");
    if (!payload || !payload.task) {
      return;
    }
    await startTask(payload.task, payload.data || {}, false);
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
    await api.tabs.executeScript(job.tabId, { file: "content.js" });
    const response = await api.tabs.sendMessage(job.tabId, {
      type: job.task.script ? "runScript" : "runTask",
      taskName: job.task.name,
      steps: job.task.steps,
      script: job.task.script || "",
      data: job.data,
      startIndex: job.stepIndex,
      variables: job.variables
    });

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

  if (message.type === "getState") {
    return (async () => {
      const state = await getStoredState();
      return {
        webhookUrl: state.webhookUrl,
        connection: state.connection,
        taskStatus: state.taskStatus,
        logs: state.logs,
        pollIntervalMinutes: state.pollIntervalMinutes,
        protocol: state.protocol,
        tasks: (state.tasks || []).map((task) => ({
          name: task.name,
          label: task.label,
          url: task.url,
          steps: task.steps || [],
          script: task.script || "",
          timeout: task.timeout,
          enabled: task.enabled !== false,
          defaultData: task.defaultData || {}
        }))
      };
    })();
  }

  if (message.type === "setWebhookUrl") {
    return (async () => {
      await api.storage.local.set({ webhookUrl: message.webhookUrl || "" });
      await api.storage.local.set({ shuaxinCursor: "0" });
      return { ok: true };
    })();
  }

  if (message.type === "setProtocol") {
    return (async () => {
      const protocol = message.protocol === "shuaxin" ? "shuaxin" : "webtask";
      await api.storage.local.set({ protocol, shuaxinCursor: "0" });
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
      const task = message.task;
      const error = validateTask(task);
      if (error) {
        return { ok: false, message: error };
      }
      const tasks = await getTasks();
      const exists = tasks.find((item) => item.name === task.name);
      if (exists && !message.allowOverwrite) {
        return { ok: false, message: "Task name already exists" };
      }
      const normalizedTask = {
        ...task,
        enabled: task.enabled !== false
      };
      const nextTasks = tasks.filter((item) => item.name !== task.name);
      nextTasks.push(normalizedTask);
      await api.storage.local.set({ tasks: nextTasks });
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
      await api.storage.local.set({ tasks: nextTasks });
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
      const nextTasks = tasks.map((task) =>
        task.name === name ? { ...task, enabled } : task
      );
      await api.storage.local.set({ tasks: nextTasks });
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
      const result = await startTask(message.taskName, message.data || {}, true);
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
  })();
});

api.runtime.onStartup.addListener(() => {
  (async () => {
    await ensureDefaults();
    const state = await getStoredState();
    await schedulePolling(state.pollIntervalMinutes);
  })();
});

(async () => {
  await ensureDefaults();
  const state = await getStoredState();
  await schedulePolling(state.pollIntervalMinutes);
})();
