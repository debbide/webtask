const api = typeof browser !== "undefined" ? browser : chrome;

const input = document.getElementById("webhook-input");
const apiKeyInput = document.getElementById("api-key-input");
const saveBtn = document.getElementById("save-btn");
const testBtn = document.getElementById("test-connection");
const statusEl = document.getElementById("status");
const tasksEl = document.getElementById("tasks");
const logsEl = document.getElementById("logs");
const intervalInput = document.getElementById("interval-input");
const protocolSelect = document.getElementById("protocol-select");
const clientIdInput = document.getElementById("client-id-input");
const copyClientIdBtn = document.getElementById("copy-client-id");
const importOpen = document.getElementById("import-open");
const importModal = document.getElementById("import-modal");
const importText = document.getElementById("import-text");
const importConfirm = document.getElementById("import-confirm");
const importCancel = document.getElementById("import-cancel");
const importError = document.getElementById("import-error");
const taskTimerModeInput = document.getElementById("task-timer-mode");
const taskCooldownMinMinutesInput = document.getElementById("task-cooldown-min-minutes");
const taskCooldownMaxMinutesInput = document.getElementById("task-cooldown-max-minutes");
const taskWindowSecondsInput = document.getElementById("task-window-seconds");
const clearLogsBtn = document.getElementById("clear-logs");
const openDashboardBtn = document.getElementById("open-dashboard");

let currentTasks = [];

function markSettingsDirty() {
  input.dataset.dirty = "1";
  apiKeyInput.dataset.dirty = "1";
  intervalInput.dataset.dirty = "1";
  protocolSelect.dataset.dirty = "1";
}

function clearSettingsDirty() {
  input.dataset.dirty = "0";
  apiKeyInput.dataset.dirty = "0";
  intervalInput.dataset.dirty = "0";
  protocolSelect.dataset.dirty = "0";
}

function setFieldValueIfClean(element, value) {
  if (!element) return;
  if (element.dataset.dirty === "1") return;
  if (document.activeElement === element) return;
  element.value = value;
}

function formatTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function formatTriggerSource(source) {
  if (source === "manual") return "手动";
  if (source === "alarm") return "定时";
  if (source === "remote") return "外部";
  return "--";
}

function renderStatus(connection) {
  const connected = connection && connection.connected;
  const dotClass = connected ? "badge connected" : "badge";
  const label = connected ? "已连接" : "未连接";
  const error = connection && connection.lastError ? ` · ${connection.lastError}` : "";
  statusEl.innerHTML = `<span class="${dotClass}"><span class="dot"></span>${label}</span>${error}`;
}

function renderTasks(tasks, taskStatus) {
  tasksEl.innerHTML = "";
  currentTasks = tasks || [];
  if (!tasks || !tasks.length) {
    tasksEl.innerHTML = "<div class=\"log-item\">暂无任务。</div>";
    return;
  }
  tasks.forEach((task) => {
    const status = taskStatus && taskStatus[task.name];
    const item = document.createElement("div");
    item.className = "task-item";

    const info = document.createElement("div");
    info.className = "task-info";

    const label = document.createElement("div");
    label.className = "task-label";
    label.textContent = task.label || task.name;

    const meta = document.createElement("div");
    meta.className = "task-meta";
    const resultLabel = status
      ? status.lastResult === "success"
        ? "成功"
        : status.lastResult === "fail"
          ? "失败"
          : status.lastResult
      : "--";
    const nextRunAt = status && status.nextRunAt ? formatTime(status.nextRunAt) : "--";
    const sourceLabel = formatTriggerSource(status && status.lastTriggerSource);
    meta.textContent = `上次：${formatTime(status && status.lastRun)} · ${resultLabel} · 下次：${nextRunAt} · 来源：${sourceLabel}`;

    info.appendChild(label);
    info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const runButton = document.createElement("button");
    runButton.className = "secondary";
    runButton.textContent = "执行";
    runButton.addEventListener("click", async () => {
      const data = task.defaultData || {};
      const response = await api.runtime.sendMessage({
        type: "triggerTask",
        taskName: task.name,
        data
      });
      if (!response || !response.ok) {
        window.alert(response && response.message ? response.message : "启动失败");
      }
    });

    const deleteButton = document.createElement("button");
    deleteButton.className = "danger";
    deleteButton.textContent = "×";
    deleteButton.title = "删除任务";
    deleteButton.addEventListener("click", async () => {
      const confirmed = window.confirm(`确定删除任务“${task.name}”吗？`);
      if (!confirmed) {
        return;
      }
      const response = await api.runtime.sendMessage({
        type: "deleteTask",
        taskName: task.name
      });
      if (!response || !response.ok) {
        window.alert(response && response.message ? response.message : "删除失败");
      }
    });

    actions.appendChild(runButton);
    actions.appendChild(deleteButton);

    item.appendChild(info);
    item.appendChild(actions);
    tasksEl.appendChild(item);
  });
}

function renderLogs(logs) {
  logsEl.innerHTML = "";
  if (!logs || !logs.length) {
    logsEl.innerHTML = "<div class=\"log-item\">暂无日志。</div>";
    return;
  }
  logs.forEach((log) => {
    const item = document.createElement("div");
    const status = log.success ? "success" : "fail";
    const statusLabel = log.success ? "成功" : "失败";
    item.className = `log-item ${status}`;
    item.innerHTML = `<strong>${log.task}</strong> · ${statusLabel} · ${formatTime(log.time)}<br>${
      log.message || ""
    }`;
    logsEl.appendChild(item);
  });
}

async function loadState() {
  const state = await api.runtime.sendMessage({ type: "getState" });
  if (!state) {
    return;
  }
  setFieldValueIfClean(input, state.webhookUrl || "");
  setFieldValueIfClean(apiKeyInput, state.webtaskApiKey || "");
  setFieldValueIfClean(intervalInput, state.pollIntervalMinutes || "");
  setFieldValueIfClean(protocolSelect, state.protocol || "webtask");
  clientIdInput.value = state.clientId || "";
  renderStatus(state.connection || {});
  renderTasks(state.tasks || [], state.taskStatus || {});
  renderLogs(state.logs || []);
}

async function copyClientId() {
  const clientId = clientIdInput.value.trim();
  if (!clientId) {
    window.alert("Client ID 暂不可用，请稍后重试");
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(clientId);
    } else {
      clientIdInput.focus();
      clientIdInput.select();
      document.execCommand("copy");
    }
    window.alert("Client ID 已复制");
  } catch (error) {
    window.alert("复制失败，请手动复制");
  }
}

function showImportModal() {
  importError.textContent = "";
  importText.value = "";
  taskTimerModeInput.value = "exact";
  taskCooldownMinMinutesInput.value = "";
  taskCooldownMaxMinutesInput.value = "";
  taskWindowSecondsInput.value = "";
  importModal.classList.remove("hidden");
}

function hideImportModal() {
  importModal.classList.add("hidden");
}

function validateTask(task) {
  if (!task || typeof task !== "object") {
    return "任务 JSON 无效";
  }
  if (!task.name || typeof task.name !== "string" || !task.name.trim()) {
    return "任务名称不能为空";
  }
  if (!task.url || typeof task.url !== "string" || !task.url.trim()) {
    return "任务 URL 不能为空";
  }
  const hasSteps = Array.isArray(task.steps) && task.steps.length > 0;
  const hasScriptString = typeof task.script === "string" && task.script.trim();
  const hasScriptArray = Array.isArray(task.script) && task.script.length > 0;
  const hasScript = hasScriptString || hasScriptArray;
  if (!hasSteps && !hasScript) {
    return "必须提供 steps 或 script";
  }
  if (hasScriptArray) {
    for (const line of task.script) {
      if (typeof line !== "string") {
        return "script 数组每一项必须是字符串";
      }
    }
  }
  if (hasSteps) {
    for (const step of task.steps) {
      if (!step || typeof step.action !== "string" || !step.action.trim()) {
        return "每个步骤都需要 action";
      }
    }
  }
  if (task.timerMode !== undefined && task.timerMode !== "exact" && task.timerMode !== "window") {
    return "timerMode 仅支持 exact 或 window";
  }
  if (task.cooldownMinutes !== undefined) {
    const raw = String(task.cooldownMinutes).trim();
    const rangeMatch = raw.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (!rangeMatch) {
      const single = Number(raw);
      if (!Number.isFinite(single) || single <= 0) {
        return "cooldownMinutes 必须是正数，或区间格式如 180-360";
      }
    } else {
      const left = Number(rangeMatch[1]);
      const right = Number(rangeMatch[2]);
      if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) {
        return "cooldownMinutes 区间必须是正数，如 180-360";
      }
    }
  }
  if (task.windowSeconds !== undefined) {
    const windowSeconds = Number(task.windowSeconds);
    if (!Number.isFinite(windowSeconds) || windowSeconds < 0) {
      return "windowSeconds 必须为大于等于 0 的数字";
    }
  }
  return "";
}

function normalizeTask(task) {
  const normalized = Array.isArray(task.script) ? { ...task, script: task.script.join("\n") } : { ...task };
  if (normalized.cooldownMinutes !== undefined) {
    normalized.cooldownMinutes = String(normalized.cooldownMinutes).trim();
  }
  if (normalized.windowSeconds !== undefined) {
    normalized.windowSeconds = Number(normalized.windowSeconds);
  }
  return normalized;
}

function applyTimerFields(task) {
  const mode = taskTimerModeInput.value === "window" ? "window" : "exact";
  const cooldownMin = taskCooldownMinMinutesInput.value.trim();
  const cooldownMax = taskCooldownMaxMinutesInput.value.trim();
  const windowSeconds = taskWindowSecondsInput.value.trim();
  const nextTask = { ...task, timerMode: mode };
  if (cooldownMin && cooldownMax) {
    nextTask.cooldownMinutes = Number(cooldownMin) === Number(cooldownMax) ? cooldownMin : `${cooldownMin}-${cooldownMax}`;
  } else if (cooldownMin) {
    nextTask.cooldownMinutes = cooldownMin;
  } else if (cooldownMax) {
    nextTask.cooldownMinutes = cooldownMax;
  } else {
    delete nextTask.cooldownMinutes;
  }
  if (windowSeconds) {
    nextTask.windowSeconds = Number(windowSeconds);
  } else {
    delete nextTask.windowSeconds;
  }
  return nextTask;
}

async function importTask() {
  importError.textContent = "";
  let task = null;
  try {
    task = JSON.parse(importText.value || "");
  } catch (error) {
    importError.textContent = "JSON 格式错误";
    return;
  }
  const error = validateTask(task);
  if (error) {
    importError.textContent = error;
    return;
  }
  task = normalizeTask(applyTimerFields(task));
  const exists = currentTasks.find((item) => item.name === task.name);
  const allowOverwrite = exists ? window.confirm("任务已存在，是否覆盖？") : false;
  if (exists && !allowOverwrite) {
    return;
  }
  const response = await api.runtime.sendMessage({
    type: "importTask",
    task,
    allowOverwrite
  });
  if (!response || !response.ok) {
    importError.textContent = response && response.message ? response.message : "导入失败";
    return;
  }
  hideImportModal();
}

saveBtn.addEventListener("click", async () => {
  try {
    const apiKey = apiKeyInput.value.trim();
    await api.runtime.sendMessage({ type: "setWebtaskApiKey", webtaskApiKey: apiKey });
    await api.runtime.sendMessage({ type: "setWebhookUrl", webhookUrl: input.value.trim() });
    await api.runtime.sendMessage({ type: "setProtocol", protocol: protocolSelect.value });
    const intervalValue = parseFloat(intervalInput.value);
    if (Number.isFinite(intervalValue) && intervalValue > 0) {
      await api.runtime.sendMessage({
        type: "setPollInterval",
        pollIntervalMinutes: intervalValue
      });
    }
    clearSettingsDirty();
    await loadState();
  } catch (error) {
    window.alert(`保存失败：${error && error.message ? error.message : "unknown error"}`);
  }
});

testBtn.addEventListener("click", async () => {
  const response = await api.runtime.sendMessage({ type: "testConnection" });
  if (!response || !response.ok) {
    window.alert(response && response.message ? response.message : "连接失败");
  } else {
    window.alert("连接成功");
  }
});

importOpen.addEventListener("click", showImportModal);
importCancel.addEventListener("click", hideImportModal);
importConfirm.addEventListener("click", importTask);

clearLogsBtn.addEventListener("click", async () => {
  const response = await api.runtime.sendMessage({ type: "clearLogs" });
  if (!response || !response.ok) {
    window.alert(response && response.message ? response.message : "清空日志失败");
  }
});

openDashboardBtn.addEventListener("click", () => {
  api.runtime.openOptionsPage();
});

copyClientIdBtn.addEventListener("click", copyClientId);

importModal.addEventListener("click", (event) => {
  if (event.target === importModal) {
    hideImportModal();
  }
});

input.addEventListener("input", markSettingsDirty);
apiKeyInput.addEventListener("input", markSettingsDirty);
intervalInput.addEventListener("input", markSettingsDirty);
protocolSelect.addEventListener("change", markSettingsDirty);

clearSettingsDirty();

api.storage.onChanged.addListener(() => {
  loadState();
});

loadState();
