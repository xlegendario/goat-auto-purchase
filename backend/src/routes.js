import express from "express";
import { getNextTask } from "./tasks.js";
import { submitTaskResult } from "./results.js";
import { recordHeartbeat, getRunnerHealth } from "./runnerHealth.js";

const router = express.Router();

router.post("/tasks/next", async (req, res) => {
  try {
    console.log("POST /tasks/next body:", req.body);

    const runnerName = req.body.runnerName;
    const accountGroupKey = req.body.accountGroupKey || null;

    const task = await getNextTask({
      runnerName,
      accountGroupKey
    });

    res.json({
      ok: true,
      task
    });
  } catch (err) {
    console.error("❌ /tasks/next failed:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

router.post("/tasks/:recordId/result", async (req, res) => {
  try {
    console.log("POST /tasks/:recordId/result", {
      recordId: req.params.recordId,
      body: req.body
    });

    const result = await submitTaskResult(req.params.recordId, req.body);

    res.json({
      ok: true,
      result
    });
  } catch (err) {
    console.error("❌ /tasks/:recordId/result failed:", err);

    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

router.post("/runner/heartbeat", (req, res) => {
  try {
    recordHeartbeat(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get("/runner/health", (req, res) => {
  res.json({ ok: true, runners: getRunnerHealth() });
});

export default router;
