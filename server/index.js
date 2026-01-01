// server/index.js
// -----------------------------------------------------------------------------
// Tiny backend proxy for Google Places (Locals)
// Routes:
//   GET /api/locals/text-search
//   GET /api/locals/nearby-search
//   GET /api/locals/place-details
//
// Run:
//   cd server
//   npm i express cors dotenv
//   node index.js
//
// Or (recommended dev):
//   npm i -D nodemon
//   nodemon index.js
// -----------------------------------------------------------------------------

import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import localsRouter from "./routes/locals.js";

dotenv.config();

const app = express();

app.use(express.json({ limit: "1mb" }));

const origins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow non-browser tools with no origin
      if (!origin) return cb(null, true);
      if (!origins.length) return cb(null, true);
      if (origins.includes(origin)) return cb(null, true);
      return cb(new Error("CORS not allowed"), false);
    },
    credentials: true,
  })
);

// Health
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, service: "locals-proxy" })
);

// Locals routes
app.use("/api/locals", localsRouter);

// Error handler (safe)
app.use((err, _req, res, _next) => {
  const status = Number(err?.status || 500);
  res.status(status).json({
    status: "ERROR",
    error: {
      message: err?.message || "Server error",
      code: err?.code || null,
    },
  });
});

const port = Number(process.env.PORT || 8787);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`[locals-proxy] listening on http://localhost:${port}`);
});
