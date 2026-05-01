import express from "express";
import dotenv from "dotenv";
import routes from "./routes.js";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "goat-auto-purchase-backend"
  });
});

app.use("/", routes);

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`GOAT backend running on port ${port}`);
});
