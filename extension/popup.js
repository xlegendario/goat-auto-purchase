async function updateStatus() {
  const statusEl = document.getElementById("status");

  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_RUNNER_STATUS" });
    statusEl.textContent = JSON.stringify(response, null, 2);
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }
}

document.getElementById("startRunner").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "START_RUNNER" });
  document.getElementById("status").textContent = JSON.stringify(response, null, 2);
});

document.getElementById("stopRunner").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "STOP_RUNNER" });
  document.getElementById("status").textContent = JSON.stringify(response, null, 2);
});

document.getElementById("forceStopRunner").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "FORCE_STOP_RUNNER" });
  document.getElementById("status").textContent = JSON.stringify(response, null, 2);
});

document.getElementById("fetchTask").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "FETCH_NEXT_TASK" });
  document.getElementById("status").textContent = JSON.stringify(response, null, 2);
});

updateStatus();
