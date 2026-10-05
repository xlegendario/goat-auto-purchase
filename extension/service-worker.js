import { CONFIG } from "./config.js";

let isRunnerEnabled = false;
let isTaskInProgress = false;
let isRunLoopActive = false;
let currentTaskStartedAt = null;
let runLoopStartedAt = null;

const LOOP_DELAY_MS = 8000;
const ERROR_RETRY_DELAY_MS = 15000;
const TASK_TIMEOUT_MS = 180000;
const FETCH_TIMEOUT_MS = 30000;
const RUN_LOOP_STALE_MS = 90000;
const RUNNER_ALARM_NAME = "goat-runner-loop";

/*
 * The runner loop is a chain of one-shot alarms. It broke whenever a
 * /tasks/next request hung (no timeout, so the loop stayed flagged as active
 * and skipped every later trigger) or an opened task never reported back.
 * Either way the runner sat idle until Start Runner was clicked again - and
 * the quieter the queue, the more polls, the more chances to hit it.
 *
 * This periodic alarm does not depend on anything finishing. Every minute it
 * runs the loop, which times out a stuck task and moves on.
 */
const WATCHDOG_ALARM_NAME = "goat-runner-watchdog";
const WATCHDOG_PERIOD_MINUTES = 1;

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

async function ensureWatchdog() {
  const existing = await chrome.alarms.get(WATCHDOG_ALARM_NAME);
  if (existing) return;

  await chrome.alarms.create(WATCHDOG_ALARM_NAME, {
    delayInMinutes: WATCHDOG_PERIOD_MINUTES,
    periodInMinutes: WATCHDOG_PERIOD_MINUTES
  });
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}


/*
 * Once a minute the runner tells the backend it is alive, which posts to
 * Discord when the pings stop or the failure streak below gets long. Sent
 * from the loop itself, so a ping only goes out while the loop really runs.
 */
const HEARTBEAT_INTERVAL_MS = 50000;
let lastHeartbeatAt = 0;

// Results that mean the page could not do its job. A logged-out account or a
// captcha turns every task into one of these. "Not found" and price results
// are about the product, not the runner, so they do not count.
function isFailureStatus(status) {
  return status === "PURCHASE_FAILED" || status === "ORDER_SYNC_FAILED";
}

/*
 * Both streaks go to the backend. The failure streak raises the alert; the
 * success streak clears it only once the runner has done a few tasks in a
 * row, so one lucky task between failures no longer sends a recovery and a
 * fresh alert a minute later.
 */
async function updateFailureStreak(failed, failure = null) {
  const { consecutiveFailures = 0, consecutiveSuccesses = 0 } =
    await chrome.storage.local.get(["consecutiveFailures", "consecutiveSuccesses"]);

  const update = failed
    ? { consecutiveFailures: consecutiveFailures + 1, consecutiveSuccesses: 0 }
    : { consecutiveFailures: 0, consecutiveSuccesses: consecutiveSuccesses + 1 };

  if (failed && failure) {
    update.lastFailure = {
      at: new Date().toISOString(),
      action: failure.action || null,
      errorMessage: String(failure.errorMessage || "").slice(0, 300)
    };
  }

  await chrome.storage.local.set(update);
}

async function sendHeartbeat({ force = false, runnerEnabled = true } = {}) {
  if (!force && Date.now() - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatAt = Date.now();

  const data = await chrome.storage.local.get([
    "lastLoopAt",
    "lastResultAt",
    "lastResultAction",
    "lastErrorAt",
    "lastError",
    "lastTimeoutTask",
    "consecutiveFailures",
    "consecutiveSuccesses",
    "lastFailure"
  ]);

  try {
    await fetchWithTimeout(`${CONFIG.BACKEND_URL}/runner/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerName: CONFIG.RUNNER_NAME,
        accountGroupKey: CONFIG.ACCOUNT_GROUP_KEY,
        runnerEnabled,
        ...data
      })
    });
  } catch (err) {
    // A missed ping is exactly what the backend watches for; nothing to do here.
    console.warn("Heartbeat failed:", err.message);
  }
}

async function describeRunnerTab() {
  const { runnerTabId } = await chrome.storage.local.get(["runnerTabId"]);
  if (!runnerTabId) return "no runner tab";

  try {
    const tab = await chrome.tabs.get(runnerTabId);
    return `${tab.url || "?"} (${tab.title || "no title"})`;
  } catch {
    return "runner tab closed";
  }
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

  const { currentTask } = await chrome.storage.local.get(["currentTask"]);
  const where = await describeRunnerTab();

  await clearCurrentTaskState();

  /*
   * A purchase that timed out may have gone through, so it is not reported:
   * the record stays PURCHASE_IN_PROGRESS and is not handed out again, which
   * rules out buying twice. It does need a human look - see lastTimeoutTask.
   * An order sync is only a read, so it is reported and the queue rotates.
   */
  if (currentTask?.recordId && currentTask.type === "GOAT_ORDER_SYNC") {
    try {
      await submitTaskResult({
        recordId: currentTask.recordId,
        status: "ORDER_SYNC_FAILED",
        errorMessage: `Runner timeout after ${TASK_TIMEOUT_MS / 1000}s; last page: ${where}`
      });
    } catch (err) {
      console.error("Could not report timed-out order sync:", err);
    }
  }

  await updateFailureStreak(true, {
    action: `TIMEOUT ${currentTask?.type || ""}`.trim(),
    errorMessage: `No result within ${TASK_TIMEOUT_MS / 1000}s; last page: ${await describeRunnerTab()}`
  });

  const { timeoutRecoveries = 0 } = await chrome.storage.local.get(["timeoutRecoveries"]);
  await chrome.storage.local.set({
    timeoutRecoveries: timeoutRecoveries + 1,
    lastTimeoutAt: new Date().toISOString(),
    lastTimeoutTask: currentTask
      ? { recordId: currentTask.recordId, type: currentTask.type, sku: currentTask.sku || null, lastPage: where }
      : null
  });

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
      const data = await chrome.storage.local.get([
        "forceStop",
        "lastLoopAt",
        "lastResultAt",
        "lastErrorAt",
        "lastError",
        "timeoutRecoveries",
        "lastTimeoutAt",
        "lastTimeoutTask"
      ]);
      const watchdog = await chrome.alarms.get(WATCHDOG_ALARM_NAME);

      sendResponse({
        ok: true,
        isRunnerEnabled,
        isTaskInProgress,
        forceStop: data.forceStop === true,
        watchdogActive: !!watchdog,
        lastLoopAt: data.lastLoopAt || null,
        lastResultAt: data.lastResultAt || null,
        lastErrorAt: data.lastErrorAt || null,
        lastError: data.lastError || null,
        timeoutRecoveries: data.timeoutRecoveries || 0,
        lastTimeoutAt: data.lastTimeoutAt || null,
        lastTimeoutTask: data.lastTimeoutTask || null,
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
        await chrome.storage.local.set({
          lastResultAt: new Date().toISOString(),
          lastResultAction: message.payload?.status || null
        });
        await updateFailureStreak(isFailureStatus(message.payload?.status), {
          action: message.payload?.status,
          errorMessage: message.payload?.errorMessage
        });

        await loadState();

        if (isRunnerEnabled) {
          await scheduleNextRun(3000);
        } else {
          console.warn("TASK_COMPLETED submitted, but runnerEnabled is false after loadState");
        }
  
        sendResponse({ ok: true, result });
      })
      .catch(async (err) => {
        console.error("TASK_COMPLETED failed:", err);

        await clearCurrentTaskState();
        await chrome.storage.local.set({
          lastErrorAt: new Date().toISOString(),
          lastError: `Result submit failed: ${err.message}`
        });
  
        await loadState();
  
        if (isRunnerEnabled) {
          await scheduleNextRun(ERROR_RETRY_DELAY_MS);
        }
  
        sendResponse({ ok: false, error: err.message });
      });
  
    return true;
  }
});

function runLoopSafely(source) {
  runLoop().catch(async (err) => {
    console.error(`GOAT runner loop error (${source}):`, err);

    await chrome.storage.local.set({
      lastErrorAt: new Date().toISOString(),
      lastError: err.message
    });

    await clearCurrentTaskState();

    if (isRunnerEnabled) {
      await scheduleNextRun(ERROR_RETRY_DELAY_MS);
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RUNNER_ALARM_NAME && alarm.name !== WATCHDOG_ALARM_NAME) return;

  runLoopSafely(alarm.name);
});

async function startRunner() {
  isRunnerEnabled = true;

  await chrome.alarms.clear(RUNNER_ALARM_NAME);

  await chrome.storage.local.set({
    runnerEnabled: true,
    forceStop: false,
    currentTask: null,
    currentTaskStartedAt: null,
    consecutiveFailures: 0
  });

  resetInProgressState();

  await ensureWatchdog();
  await scheduleNextRun(500);

  runLoopSafely("start");

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
  await chrome.alarms.clear(WATCHDOG_ALARM_NAME);
  await sendHeartbeat({ force: true, runnerEnabled: false });

  return {
    ok: true,
    message: "GOAT runner will stop after current task"
  };
}

async function forceStopRunner() {
  isRunnerEnabled = false;
  resetInProgressState();

  await chrome.alarms.clear(RUNNER_ALARM_NAME);
  await chrome.alarms.clear(WATCHDOG_ALARM_NAME);

  await chrome.storage.local.set({
    runnerEnabled: false,
    forceStop: true,
    currentTask: null,
    currentTaskStartedAt: null,
    runnerTabId: null
  });

  await sendHeartbeat({ force: true, runnerEnabled: false });

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
  // A loop that hangs on an API call must not lock out every later trigger.
  const isStale =
    runLoopStartedAt !== null && Date.now() - runLoopStartedAt > RUN_LOOP_STALE_MS;

  if (isRunLoopActive && !isStale) return;

  isRunLoopActive = true;
  runLoopStartedAt = Date.now();

  try {
    await loadState();

    if (!isRunnerEnabled) return;

    await ensureWatchdog();
    await chrome.storage.local.set({ lastLoopAt: new Date().toISOString() });
    await sendHeartbeat();

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
    runLoopStartedAt = null;
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

  const startUrl = task.goatOrderUrl || task.goatUrl;

  const tab = await openOrReuseRunnerTab(startUrl);
  
  return {
    ok: true,
    task,
    openedUrl: startUrl,
    tabId: tab.id
  };
}

async function fetchNextTask() {
  const res = await fetchWithTimeout(`${CONFIG.BACKEND_URL}/tasks/next`, {
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

  const res = await fetchWithTimeout(`${CONFIG.BACKEND_URL}/tasks/${payload.recordId}/result`, {
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

// Runs on every worker start, including the first one after Chrome restarts.
loadState().then(async () => {
  if (!isRunnerEnabled) return;

  await ensureWatchdog();
  await scheduleNextRun(1000);
  runLoopSafely("boot");
});
