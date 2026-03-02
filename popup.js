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
const importOpen = document.getElementById("import-open");
const importModal = document.getElementById("import-modal");
const importText = document.getElementById("import-text");
const importConfirm = document.getElementById("import-confirm");
const importCancel = document.getElementById("import-cancel");
const importError = document.getElementById("import-error");
const clearLogsBtn = document.getElementById("clear-logs");
const openDashboardBtn = document.getElementById("open-dashboard");

let currentTasks = [];

function formatTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
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
    meta.textContent = `上次：${formatTime(status && status.lastRun)} · ${resultLabel}`;

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
  input.value = state.webhookUrl || "";
  apiKeyInput.value = state.webtaskApiKey || "";
  intervalInput.value = state.pollIntervalMinutes || "";
  protocolSelect.value = state.protocol || "webtask";
  renderStatus(state.connection || {});
  renderTasks(state.tasks || [], state.taskStatus || {});
  renderLogs(state.logs || []);
}

function showImportModal() {
  importError.textContent = "";
  importText.value = "";
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
  return "";
}

function normalizeTask(task) {
  if (Array.isArray(task.script)) {
    return { ...task, script: task.script.join("\n") };
  }
  return task;
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
  task = normalizeTask(task);
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
  await api.runtime.sendMessage({ type: "setWebhookUrl", webhookUrl: input.value.trim() });
  await api.storage.local.set({ webtaskApiKey: apiKeyInput.value.trim() });
  await api.runtime.sendMessage({ type: "setProtocol", protocol: protocolSelect.value });
  const intervalValue = parseFloat(intervalInput.value);
  if (Number.isFinite(intervalValue) && intervalValue > 0) {
    await api.runtime.sendMessage({
      type: "setPollInterval",
      pollIntervalMinutes: intervalValue
    });
  }
  await loadState();
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

importModal.addEventListener("click", (event) => {
  if (event.target === importModal) {
    hideImportModal();
  }
});

api.storage.onChanged.addListener(() => {
  loadState();
});

loadState();
