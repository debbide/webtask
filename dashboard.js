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
const importModalTitle = importModal.querySelector(".modal-title");
const importText = document.getElementById("import-text");
const importConfirm = document.getElementById("import-confirm");
const importCancel = document.getElementById("import-cancel");
const importError = document.getElementById("import-error");
const taskTimerModeInput = document.getElementById("task-timer-mode");
const taskCooldownMinMinutesInput = document.getElementById("task-cooldown-min-minutes");
const taskCooldownMaxMinutesInput = document.getElementById("task-cooldown-max-minutes");
const taskWindowSecondsInput = document.getElementById("task-window-seconds");
const logsModal = document.getElementById("logs-modal");
const logsModalTitle = document.getElementById("logs-modal-title");
const logsModalList = document.getElementById("logs-modal-list");
const logsModalClose = document.getElementById("logs-modal-close");
const clearLogsBtn = document.getElementById("clear-logs");
const taskSearch = document.getElementById("task-search");

let currentTasks = [];
let currentStatus = {};
let searchTerm = "";
let editingTaskName = null;
let logFilterTask = "";
let lastLogs = [];

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

function getTaskType(task) {
  const hasSteps = Array.isArray(task.steps) && task.steps.length > 0;
  const hasScriptString = typeof task.script === "string" && task.script.trim();
  const hasScriptArray = Array.isArray(task.script) && task.script.length > 0;
  const hasScript = !!(hasScriptString || hasScriptArray);
  if (hasSteps && hasScript) return "混合";
  if (hasScript) return "脚本";
  return "步骤";
}

function formatJson(value) {
  if (!value) return "--";
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

function renderTasks(tasks, taskStatus) {
  tasksEl.innerHTML = "";
  currentTasks = tasks || [];
  currentStatus = taskStatus || {};
  const filtered = currentTasks.filter((task) => {
    if (!searchTerm) return true;
    const keyword = searchTerm.toLowerCase();
    return (
      (task.name || "").toLowerCase().includes(keyword) ||
      (task.label || "").toLowerCase().includes(keyword)
    );
  });

  if (!filtered.length) {
    tasksEl.innerHTML = "<div class=\"log-item\">暂无任务。</div>";
    return;
  }

  filtered.forEach((task) => {
    const status = currentStatus[task.name];
    const row = document.createElement("div");
    row.className = "task-row";
    row.dataset.name = task.name;
    if (task.enabled === false) {
      row.classList.add("disabled");
    }

    const toggleCell = document.createElement("div");
    toggleCell.className = "col-toggle";
    const switchLabel = document.createElement("label");
    switchLabel.className = "switch";
    const toggleInput = document.createElement("input");
    toggleInput.type = "checkbox";
    toggleInput.checked = task.enabled !== false;
    toggleInput.addEventListener("click", (event) => event.stopPropagation());
    toggleInput.addEventListener("change", async (event) => {
      const response = await api.runtime.sendMessage({
        type: "setTaskEnabled",
        taskName: task.name,
        enabled: event.target.checked
      });
      if (!response || !response.ok) {
        window.alert(response && response.message ? response.message : "更新失败");
      }
    });
    const slider = document.createElement("span");
    slider.className = "slider";
    switchLabel.appendChild(toggleInput);
    switchLabel.appendChild(slider);
    toggleCell.appendChild(switchLabel);

    const nameCell = document.createElement("div");
    nameCell.className = "col-name";
    const nextRunAt = status && status.nextRunAt ? formatTime(status.nextRunAt) : "--";
    const triggerSource = formatTriggerSource(status && status.lastTriggerSource);
    nameCell.innerHTML = `<div class="task-name">${task.label || task.name}</div><div class="task-sub">${
      task.name
    }</div><div class="task-sub">下次: ${nextRunAt} · 来源: ${triggerSource}</div>`;

    const typeCell = document.createElement("div");
    typeCell.className = "col-type task-type";
    typeCell.textContent = getTaskType(task);

    const lastCell = document.createElement("div");
    lastCell.className = "col-last task-last";
    lastCell.textContent = formatTime(status && status.lastRun);

    const statusCell = document.createElement("div");
    statusCell.className = "col-status";
    const resultLabel = status
      ? status.lastResult === "success"
        ? "成功"
        : status.lastResult === "fail"
          ? "失败"
          : status.lastResult
      : "--";
    const pill = document.createElement("span");
    pill.className = `status-pill ${status ? status.lastResult : ""}`;
    pill.textContent = resultLabel;
    statusCell.appendChild(pill);

    const actionsCell = document.createElement("div");
    actionsCell.className = "col-actions task-actions";
    const runButton = document.createElement("button");
    runButton.className = "secondary btn";
    runButton.textContent = "执行";
    runButton.disabled = task.enabled === false;
    runButton.addEventListener("click", (event) => {
      event.stopPropagation();
      triggerTask(task);
    });
    const logButton = document.createElement("button");
    logButton.className = "secondary btn";
    logButton.textContent = "日志";
    logButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openLogsModal(task.name);
    });
    const editButton = document.createElement("button");
    editButton.className = "secondary btn";
    editButton.textContent = "编辑";
    editButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openEditTask(task);
    });
    const deleteButton = document.createElement("button");
    deleteButton.className = "danger btn";
    deleteButton.textContent = "×";
    deleteButton.title = "删除任务";
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteTask(task);
    });
    actionsCell.appendChild(runButton);
    actionsCell.appendChild(logButton);
    actionsCell.appendChild(editButton);
    actionsCell.appendChild(deleteButton);

    row.appendChild(toggleCell);
    row.appendChild(nameCell);
    row.appendChild(typeCell);
    row.appendChild(lastCell);
    row.appendChild(statusCell);
    row.appendChild(actionsCell);
    tasksEl.appendChild(row);
  });
}

function renderLogs(logs) {
  lastLogs = logs || [];
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
  editingTaskName = null;
  importConfirm.textContent = "导入";
  if (importModalTitle) {
    importModalTitle.textContent = "导入任务 JSON";
  }
  importModal.classList.remove("hidden");
}

function hideImportModal() {
  importModal.classList.add("hidden");
  editingTaskName = null;
  importConfirm.textContent = "导入";
  if (importModalTitle) {
    importModalTitle.textContent = "导入任务 JSON";
  }
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

function parseCooldownRangeForForm(value) {
  const text = String(value || "").trim();
  if (!text) return { min: "", max: "" };
  const rangeMatch = text.match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
  if (rangeMatch) {
    return { min: rangeMatch[1], max: rangeMatch[2] };
  }
  return { min: text, max: text };
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
  const exists = currentTasks.find(
    (item) => item.name === task.name && item.name !== editingTaskName
  );
  const allowOverwrite = exists ? window.confirm("任务已存在，是否覆盖？") : false;
  if (exists && !allowOverwrite) {
    return;
  }
  const response = await api.runtime.sendMessage({
    type: "importTask",
    task,
    allowOverwrite,
    replaceTaskName: editingTaskName || ""
  });
  if (!response || !response.ok) {
    importError.textContent = response && response.message ? response.message : editingTaskName ? "保存失败" : "导入失败";
    return;
  }
  hideImportModal();
}


function openLogsModal(taskName) {
  logFilterTask = taskName || "";
  logsModalTitle.textContent = taskName ? `任务：${taskName}` : "全部";
  renderLogsModal();
  logsModal.classList.remove("hidden");
}

function renderLogsModal() {
  logsModalList.innerHTML = "";
  const filtered = logFilterTask
    ? lastLogs.filter((log) => log.task === logFilterTask)
    : lastLogs;
  if (!filtered.length) {
    logsModalList.innerHTML = "<div class=\"log-item\">暂无日志。</div>";
    return;
  }
  filtered.forEach((log) => {
    const item = document.createElement("div");
    const status = log.success ? "success" : "fail";
    const statusLabel = log.success ? "成功" : "失败";
    item.className = `log-item ${status}`;
    item.innerHTML = `<strong>${log.task}</strong> · ${statusLabel} · ${formatTime(log.time)}<br>${
      log.message || ""
    }`;
    logsModalList.appendChild(item);
  });
}

function openEditTask(task) {
  editingTaskName = task.name;
  importError.textContent = "";
  importConfirm.textContent = "保存";
  if (importModalTitle) {
    importModalTitle.textContent = "编辑任务 JSON";
  }
  importText.value = JSON.stringify(task, null, 2);
  taskTimerModeInput.value = task.timerMode === "window" ? "window" : "exact";
  const cooldownRange = parseCooldownRangeForForm(task.cooldownMinutes);
  taskCooldownMinMinutesInput.value = cooldownRange.min;
  taskCooldownMaxMinutesInput.value = cooldownRange.max;
  taskWindowSecondsInput.value = task.windowSeconds !== undefined ? String(task.windowSeconds) : "";
  importModal.classList.remove("hidden");
}

async function triggerTask(task) {
  const data = task.defaultData || {};
  const response = await api.runtime.sendMessage({
    type: "triggerTask",
    taskName: task.name,
    data
  });
  if (!response || !response.ok) {
    window.alert(response && response.message ? response.message : "启动失败");
  }
}

async function deleteTask(task) {
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

clearLogsBtn?.addEventListener("click", async () => {
  const response = await api.runtime.sendMessage({ type: "clearLogs" });
  if (!response || !response.ok) {
    window.alert(response && response.message ? response.message : "清空日志失败");
  }
});

logsModalClose.addEventListener("click", () => {
  logsModal.classList.add("hidden");
});

copyClientIdBtn.addEventListener("click", copyClientId);

taskSearch.addEventListener("input", (event) => {
  searchTerm = event.target.value.trim();
  renderTasks(currentTasks, currentStatus);
});

importModal.addEventListener("click", (event) => {
  if (event.target === importModal) {
    hideImportModal();
  }
});

logsModal.addEventListener("click", (event) => {
  if (event.target === logsModal) {
    logsModal.classList.add("hidden");
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
