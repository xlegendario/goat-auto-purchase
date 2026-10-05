/*
 * Runner heartbeat -> Discord.
 *
 * The runner is a Chrome extension on the VPS. When it stops - Chrome or the
 * VPS restarted, GOAT logged out or showing a captcha, Render or Airtable
 * down - nothing here notices; the queue simply stops moving. So each runner
 * pings once a minute with its state, and a check here posts to Discord when
 * a runner goes quiet or keeps failing, and once more when it recovers.
 *
 * State lives in memory. After a Render restart a runner counts again from
 * its first ping, which is a blind spot only if the VPS died at the same time.
 */

const SERVICE_LABEL = "GOAT Auto Purchase";

const SILENT_AFTER_MS = 15 * 60 * 1000;
const FAILURE_STREAK_ALERT = 5;
const RECOVERY_STREAK = 3;
const RECENT_ERROR_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;

// runnerKey -> { heartbeat, lastSeenAt, silentAlerted, failingAlerted }
const runners = new Map();

function runnerKey(runnerName, accountGroupKey) {
  return `${runnerName}|${accountGroupKey || "-"}`;
}

function formatTime(iso) {
  if (!iso) return "unknown";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";

  return date.toLocaleString("en-GB", {
    timeZone: "Europe/Amsterdam",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function runnerTitle(heartbeat) {
  const group = heartbeat.accountGroupKey ? ` (${heartbeat.accountGroupKey})` : "";
  return `**${heartbeat.runnerName}**${group} · ${SERVICE_LABEL}`;
}

function detailLines(heartbeat) {
  const lines = [`Last loop: ${formatTime(heartbeat.lastLoopAt)}`];

  if (heartbeat.lastResultAt) {
    lines.push(`Last result: ${formatTime(heartbeat.lastResultAt)}${heartbeat.lastResultAction ? ` (${heartbeat.lastResultAction})` : ""}`);
  }

  // The task that actually failed, which is what explains an alert.
  if (heartbeat.lastFailure) {
    const failure = heartbeat.lastFailure;
    const detail = failure.errorMessage ? ` - \`${String(failure.errorMessage).slice(0, 300)}\`` : "";
    lines.push(`Last failed task (${formatTime(failure.at)}): ${failure.action || "unknown"}${detail}`);
  }

  // Loop errors (backend unreachable and such) stay in the extension until
  // the next one, so only a recent one says anything about now.
  const errorAge = heartbeat.lastErrorAt ? Date.now() - new Date(heartbeat.lastErrorAt).getTime() : Infinity;

  if (heartbeat.lastError && errorAge < RECENT_ERROR_MS) {
    lines.push(`Last loop error (${formatTime(heartbeat.lastErrorAt)}): \`${String(heartbeat.lastError).slice(0, 300)}\``);
  }

  return lines;
}

async function postToDiscord(content) {
  // Read per call: dotenv runs after the imports have been evaluated.
  const webhookUrl = process.env.DISCORD_RUNNER_ALERTS_WEBHOOK;

  if (!webhookUrl) {
    console.warn("DISCORD_RUNNER_ALERTS_WEBHOOK not set, alert not sent:", content);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: controller.signal
    });

    if (!res.ok) {
      console.error("Discord alert failed:", res.status, await res.text());
    }
  } catch (err) {
    console.error("Discord alert failed:", err.message);
  } finally {
    clearTimeout(timeout);
  }
}

export function recordHeartbeat(body) {
  const runnerName = String(body?.runnerName || "").trim();

  if (!runnerName) {
    throw new Error("runnerName is required");
  }

  const heartbeat = {
    runnerName,
    accountGroupKey: String(body.accountGroupKey || "").trim() || null,
    runnerEnabled: body.runnerEnabled !== false,
    lastLoopAt: body.lastLoopAt || null,
    lastResultAt: body.lastResultAt || null,
    lastResultAction: body.lastResultAction || null,
    lastErrorAt: body.lastErrorAt || null,
    lastError: body.lastError || null,
    lastTimeoutTask: body.lastTimeoutTask || null,
    consecutiveFailures: Number(body.consecutiveFailures) || 0,
    // Older extensions do not send it; treat a zero failure streak as recovered.
    consecutiveSuccesses:
      body.consecutiveSuccesses === undefined
        ? (Number(body.consecutiveFailures) || 0) === 0 ? RECOVERY_STREAK : 0
        : Number(body.consecutiveSuccesses) || 0,
    lastFailure: body.lastFailure || null
  };

  const key = runnerKey(heartbeat.runnerName, heartbeat.accountGroupKey);
  const previous = runners.get(key);

  const state = {
    silentAlerted: false,
    failingAlerted: false,
    ...previous,
    heartbeat,
    lastSeenAt: Date.now()
  };

  runners.set(key, state);

  // Evaluated right away, so a recovery or a failure streak is reported
  // with this ping rather than up to a minute later.
  evaluate(state).catch((err) => console.error("Runner health check failed:", err));
}

async function evaluate(state) {
  const { heartbeat } = state;
  const silentFor = Date.now() - state.lastSeenAt;

  // Stopped on purpose: no alerts, and a later start begins clean.
  if (!heartbeat.runnerEnabled) {
    state.silentAlerted = false;
    state.failingAlerted = false;
    return;
  }

  if (silentFor >= SILENT_AFTER_MS && !state.silentAlerted) {
    state.silentAlerted = true;
    await postToDiscord(
      [
        `🔴 ${runnerTitle(heartbeat)} has not checked in for ${Math.round(silentFor / 60000)} min. Chrome, the VPS or the extension has probably stopped.`,
        `Last ping: ${formatTime(new Date(state.lastSeenAt).toISOString())}`,
        ...detailLines(heartbeat)
      ].join("\n")
    );
    return;
  }

  if (silentFor < SILENT_AFTER_MS && state.silentAlerted) {
    state.silentAlerted = false;
    await postToDiscord(`🟢 ${runnerTitle(heartbeat)} is checking in again.`);
  }

  if (heartbeat.consecutiveFailures >= FAILURE_STREAK_ALERT && !state.failingAlerted) {
    state.failingAlerted = true;
    await postToDiscord(
      [
        `🟠 ${runnerTitle(heartbeat)} is running, but the last ${heartbeat.consecutiveFailures} tasks failed or got stuck. Possibly logged out or a captcha.`,
        ...detailLines(heartbeat)
      ].join("\n")
    );
    return;
  }

  if (heartbeat.consecutiveSuccesses >= RECOVERY_STREAK && state.failingAlerted) {
    state.failingAlerted = false;
    await postToDiscord(`🟢 ${runnerTitle(heartbeat)} is completing tasks again (${heartbeat.consecutiveSuccesses} in a row).`);
  }
}

export function startRunnerHealthChecks() {
  setInterval(() => {
    for (const state of runners.values()) {
      evaluate(state).catch((err) => console.error("Runner health check failed:", err));
    }
  }, CHECK_INTERVAL_MS);
}

export function getRunnerHealth() {
  return Array.from(runners.values()).map((state) => ({
    ...state.heartbeat,
    lastSeenAt: new Date(state.lastSeenAt).toISOString(),
    silentAlerted: state.silentAlerted,
    failingAlerted: state.failingAlerted
  }));
}
