"use strict";

const express = require("express");

const app = express();

app.use(express.json());

// Dummy credential check — NOT real auth. The demo target is rate limiting,
// not authentication. The live demo worker will add express-rate-limit
// middleware (max 5 req/min per IP) to this route.
app.post("/api/login", (req, res) => {
  const { username, password } = req.body ?? {};

  if (username === "demo" && password === "demo") {
    return res.status(200).json({ ok: true });
  }

  return res.status(401).json({ ok: false });
});

module.exports = { app };
