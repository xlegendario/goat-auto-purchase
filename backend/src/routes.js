import express from "express";
import { getNextTask } from "./tasks.js";
import { submitTaskResult } from "./results.js";

const router = express.Router();

router.post("/tasks/next", async (req, res) => {
  try {
    const task = await getNextTask();

    res.json({
      ok: true,
      task
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

router.post("/tasks/:recordId/result", async (req, res) => {
  try {
    const result = await submitTaskResult(req.params.recordId, req.body);

    res.json({
      ok: true,
      result
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

export default router;
