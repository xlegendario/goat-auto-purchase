import { CONFIG } from "./config.js";

let isRunnerEnabled = false;
let isTaskInProgress = false;
let isRunLoopActive = false;
let currentTaskStartedAt = null;

const LOOP_DELAY_MS = 8000;
const ERROR_RETRY_DELAY_MS = 15000;
const TASK_TIMEOUT_MS = 180000;
const RUNNER_ALARM_NAME = "goat-runner-loop";

function resetInProgressState() {
  isTaskInProgress = false;
  currentTaskStartedAt = null;
}

async function clearCurrentTaskState() {
  resetInProgressState();

  await chrome.storage.local.set({
    currentTask: null,
    currentTaskStartedAt: null
  });
}

async function loadState() {
  const data = await chrome.storage.local.get([
    "runnerEnabled",
    "forceStop",
    "currentTask",
    "currentTaskStartedAt"
  ]);

  isRunnerEnabled = data.runnerEnabled === true;
  isTaskInProgress = !!data.currentTask;
  currentTaskStartedAt =
    typeof data.currentTaskStartedAt === "number"
      ? data.currentTaskStartedAt
      : null;
}

async function saveState(forceStop = false) {
  await chrome.storage.local.set({
    runnerEnabled: isRunnerEnabled,
    forceStop
  });
}

async function recoverIfTaskTimedOut() {
  if (!isTaskInProgress || !currentTaskStartedAt) return false;

  const elapsed = Date.now() - currentTaskStartedAt;

  if (elapsed < TASK_TIMEOUT_MS) return false;

  console.warn("GOAT task timed out, clearing local state");
  await clearCurrentTaskState();
  return true;
}

async function scheduleNextRun(delayMs) {
  if (!isRunnerEnabled) return;

  await chrome.alarms.clear(RUNNER_ALARM_NAME);

  await chrome.alarms.create(RUNNER_ALARM_NAME, {
    delayInMinutes: Math.max(delayMs / 60000, 0.1)
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "FETCH_NEXT_TASK") {
    handleSingleTask()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true;
  }

  if (message.type === "START_RUNNER") {
    startRunner()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true;
  }

  if (message.type === "STOP_RUNNER") {
    stopRunner()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true;
  }

  if (message.type === "FORCE_STOP_RUNNER") {
    forceStopRunner()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true;
  }

  if (message.type === "GET_RUNNER_STATUS") {
    loadState().then(async () => {
      const data = await chrome.storage.local.get(["forceStop"]);

      sendResponse({
        ok: true,
        isRunnerEnabled,
        isTaskInProgress,
        forceStop: data.forceStop === true,
        config: {
          backendUrl: CONFIG.BACKEND_URL,
          runnerName: CONFIG.RUNNER_NAME,
          accountGroupKey: CONFIG.ACCOUNT_GROUP_KEY,
          dryRun: CONFIG.DRY_RUN
        }
      });
    });

    return true;
  }

  if (message.type === "TASK_COMPLETED") {
    submitTaskResult(message.payload)
      .then(async (result) => {
        await clearCurrentTaskState();

        if (isRunnerEnabled) {
          await scheduleNextRun(3000);
          setTimeout(() => runLoop().catch(console.error), 3000);
        }

        sendResponse({ ok: true, result });
      })
      .catch(async (err) => {
        await clearCurrentTaskState();

        if (isRunnerEnabled) {
          await scheduleNextRun(ERROR_RETRY_DELAY_MS);
        }

        sendResponse({ ok: false, error: err.message });
      });

    return true;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RUNNER_ALARM_NAME) return;

  runLoop().catch(async (err) => {
    console.error("GOAT runner loop error:", err);
    await clearCurrentTaskState();

    if (isRunnerEnabled) {
      await scheduleNextRun(ERROR_RETRY_DELAY_MS);
    }
  });
});

async function startRunner() {
  isRunnerEnabled = true;

  await chrome.alarms.clear(RUNNER_ALARM_NAME);

  await chrome.storage.local.set({
    runnerEnabled: true,
    forceStop: false,
    currentTask: null,
    currentTaskStartedAt: null
  });

  resetInProgressState();

  await scheduleNextRun(500);

  runLoop().catch(console.error);

  return {
    ok: true,
    message: "GOAT runner started",
    isRunnerEnabled,
    dryRun: CONFIG.DRY_RUN
  };
}

async function stopRunner() {
  isRunnerEnabled = false;

  await saveState(false);
  await chrome.alarms.clear(RUNNER_ALARM_NAME);

  return {
    ok: true,
    message: "GOAT runner will stop after current task"
  };
}

async function forceStopRunner() {
  isRunnerEnabled = false;
  resetInProgressState();

  await chrome.alarms.clear(RUNNER_ALARM_NAME);

  await chrome.storage.local.set({
    runnerEnabled: false,
    forceStop: true,
    currentTask: null,
    currentTaskStartedAt: null,
    runnerTabId: null
  });

  const tabs = await chrome.tabs.query({
    url: ["*://www.goat.com/*", "*://goat.com/*"]
  });

  for (const tab of tabs) {
    if (tab.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {}
    }
  }

  return {
    ok: true,
    message: "GOAT runner force stopped"
  };
}

async function runLoop() {
  if (isRunLoopActive) return;

  isRunLoopActive = true;

  try {
    await loadState();

    if (!isRunnerEnabled) return;

    await recoverIfTaskTimedOut();
    await loadState();

    if (isTaskInProgress) {
      await scheduleNextRun(2000);
      return;
    }

    const result = await handleSingleTask();

    if (!result.task && isRunnerEnabled) {
      await scheduleNextRun(LOOP_DELAY_MS);
    }
  } finally {
    isRunLoopActive = false;
  }
}

async function handleSingleTask() {
  if (isTaskInProgress) {
    return {
      ok: true,
      message: "Task already in progress"
    };
  }

  const taskData = await fetchNextTask();

  await loadState();

  const stopData = await chrome.storage.local.get(["forceStop"]);

  if (!isRunnerEnabled && stopData.forceStop === true) {
    await clearCurrentTaskState();

    return {
      ok: true,
      message: "Runner stopped",
      task: null
    };
  }

  if (!taskData.task) {
    return {
      ok: true,
      message: "No GOAT task available",
      task: null
    };
  }

  const task = {
    ...taskData.task,
    dryRun: CONFIG.DRY_RUN
  };

  isTaskInProgress = true;
  currentTaskStartedAt = Date.now();

  await chrome.storage.local.set({
    currentTask: task,
    currentTaskStartedAt,
    forceStop: false
  });

  const tab = await openOrReuseRunnerTab(task.goatUrl);

  return {
    ok: true,
    task,
    openedUrl: task.goatUrl,
    tabId: tab.id
  };
}

async function fetchNextTask() {
  const res = await fetch(`${CONFIG.BACKEND_URL}/tasks/next`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      runnerName: CONFIG.RUNNER_NAME,
      accountGroupKey: CONFIG.ACCOUNT_GROUP_KEY
    })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to fetch GOAT task");
  }

  return data;
}

async function submitTaskResult(payload) {
  if (!payload?.recordId) {
    throw new Error("Missing recordId in GOAT task result");
  }

  const res = await fetch(`${CONFIG.BACKEND_URL}/tasks/${payload.recordId}/result`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to submit GOAT task result");
  }

  return data;
}

async function openOrReuseRunnerTab(url) {
  const data = await chrome.storage.local.get(["runnerTabId"]);
  const existingTabId = data.runnerTabId;

  if (existingTabId) {
    try {
      const existingTab = await chrome.tabs.get(existingTabId);

      if (existingTab?.id) {
        return await chrome.tabs.update(existingTab.id, {
          url,
          active: true
        });
      }
    } catch {}
  }

  const newTab = await chrome.tabs.create({
    url,
    active: true
  });

  if (newTab?.id) {
    await chrome.storage.local.set({
      runnerTabId: newTab.id
    });
  }

  return newTab;
}
