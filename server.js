// server.js : START HERE. Run with:  npm start
// Sets up Express, login sessions, the API routes, and starts the scheduler.
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const net = require("net");
const db = require("./database");
const monitor = require("./monitor");

const app = express();
const PROD = process.env.NODE_ENV === "production";
if (PROD) app.set("trust proxy", 1);

/* ---------- middleware (runs on every request, in this order) ---------- */
app.use(express.json({ limit: "10kb" }));               // fills req.body from JSON
app.use(session({                                        // remembers who is logged in (req.session)
  secret: process.env.SESSION_SECRET || "dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 7 * 24 * 3600 * 1000 },
}));
app.use(express.static(path.join(__dirname, "public")));  // serves index.html, style.css, app.js

// Blocks anyone who is not logged in.
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please log in." });
  next();
}
const bad = (res, message, status = 400) => res.status(status).json({ error: message });

/* ---------- input checks ---------- */
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;

// Only http/https, and (unless allowed) nothing on localhost / private networks,
// otherwise users could make OUR server probe internal services.
function checkUrl(value) {
  let u;
  try { u = new URL(String(value).trim()); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
  if (process.env.ALLOW_LOCAL_URLS !== "true") {
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const privateV4 = net.isIPv4(h) && /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(h);
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || privateV4 || net.isIPv6(h)) return null;
  }
  return u.toString();
}

/* ---------- AUTH ---------- */
app.post("/api/register", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const { password, confirmPassword } = req.body;
  if (!name || name.length > 100) return bad(res, "Please enter your name.");
  if (!isEmail(email)) return bad(res, "Please enter a valid email.");
  if (typeof password !== "string" || password.length < 8 || password.length > 72) return bad(res, "Password must be 8 to 72 characters.");
  if (password !== confirmPassword) return bad(res, "Passwords do not match.");
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) return bad(res, "That email is already registered.", 409);

  const hash = await bcrypt.hash(password, 10);         // never store the real password
  db.prepare("INSERT INTO users (name, email, password_hash) VALUES (?,?,?)").run(name, email, hash);
  res.status(201).json({ message: "Account created. Please log in." });
});

app.post("/api/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  const ok = user && (await bcrypt.compare(String(req.body.password || ""), user.password_hash));
  if (!ok) return bad(res, "Invalid email or password.", 401);   // same message for both cases on purpose
  req.session.regenerate(() => {                                 // fresh session id on login
    req.session.userId = user.id;
    res.json({ name: user.name, email: user.email });
  });
});

app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ message: "Logged out." })));

app.get("/api/me", requireLogin, (req, res) => {
  res.json(db.prepare("SELECT name, email FROM users WHERE id = ?").get(req.session.userId));
});

/* ---------- WEBSITES ---------- */
function uptimeSince(websiteId, sinceIso) {
  const r = db.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(status='UP'),0) AS up, AVG(CASE WHEN status='UP' THEN response_time END) AS avg FROM checks WHERE website_id = ? AND checked_at >= ?"
  ).get(websiteId, sinceIso);
  return { total: r.total, up: r.up, uptime: r.total ? Math.round((r.up / r.total) * 10000) / 100 : null, avgResponse: r.avg === null ? null : Math.round(r.avg) };
}
const DAY_AGO = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const ALL_TIME = "1970-01-01T00:00:00.000Z";

// Dashboard: numbers + all my websites + recent incidents, in one call.
app.get("/api/dashboard", requireLogin, (req, res) => {
  const sites = db.prepare("SELECT * FROM websites WHERE user_id = ? ORDER BY id DESC").all(req.session.userId);
  const lastCheck = db.prepare("SELECT response_time FROM checks WHERE website_id = ? AND status = 'UP' ORDER BY id DESC LIMIT 1");

  const websites = sites.map((w) => ({
    id: w.id, url: w.url, alertEmail: w.alert_email, status: w.status,
    consecutiveFailures: w.consecutive_failures, lastCheckedAt: w.last_checked_at,
    uptime24h: uptimeSince(w.id, DAY_AGO()).uptime,
    uptimeAll: uptimeSince(w.id, ALL_TIME).uptime,
    responseTime: lastCheck.get(w.id)?.response_time ?? null,
  }));

  const incidents = db.prepare(
    "SELECT i.*, w.url FROM incidents i JOIN websites w ON w.id = i.website_id WHERE w.user_id = ? ORDER BY i.started_at DESC LIMIT 10"
  ).all(req.session.userId);

  const up = db.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(c.status='UP'),0) AS up FROM checks c JOIN websites w ON w.id = c.website_id WHERE w.user_id = ? AND c.checked_at >= ?"
  ).get(req.session.userId, DAY_AGO());

  res.json({
    summary: {
      total: websites.length,
      online: websites.filter((w) => w.status === "UP").length,
      offline: websites.filter((w) => w.status === "DOWN").length,
      overallUptime24h: up.total ? Math.round((up.up / up.total) * 10000) / 100 : null,
    },
    websites,
    incidents,
  });
});

app.post("/api/websites", requireLogin, (req, res) => {
  const url = checkUrl(req.body.url);
  const alertEmail = String(req.body.alertEmail || "").trim().toLowerCase();
  if (!url) return bad(res, "Enter a valid public URL starting with http:// or https://");
  if (!isEmail(alertEmail)) return bad(res, "Enter a valid alert email.");
  if (db.prepare("SELECT COUNT(*) AS n FROM websites WHERE user_id = ?").get(req.session.userId).n >= 20) return bad(res, "Limit: 20 websites.");
  if (db.prepare("SELECT id FROM websites WHERE user_id = ? AND url = ?").get(req.session.userId, url)) return bad(res, "You already monitor this URL.", 409);

  const info = db.prepare("INSERT INTO websites (user_id, url, alert_email) VALUES (?,?,?)").run(req.session.userId, url, alertEmail);
  monitor.runCheck(db.prepare("SELECT * FROM websites WHERE id = ?").get(info.lastInsertRowid)); // first check right away (background)
  res.status(201).json({ id: info.lastInsertRowid });
});

// Loads a website ONLY if it belongs to the logged-in user (this is the "own websites only" rule).
function myWebsite(req) {
  return db.prepare("SELECT * FROM websites WHERE id = ? AND user_id = ?").get(Number(req.params.id) || 0, req.session.userId);
}

// Details for one website: stats + recent checks + its incidents.
app.get("/api/websites/:id", requireLogin, (req, res) => {
  const w = myWebsite(req);
  if (!w) return bad(res, "Website not found.", 404);
  const stats24h = uptimeSince(w.id, DAY_AGO());
  const statsAll = uptimeSince(w.id, ALL_TIME);
  res.json({
    website: { id: w.id, url: w.url, status: w.status, alertEmail: w.alert_email },
    stats: { uptime24h: stats24h.uptime, uptimeAll: statsAll.uptime, totalChecks: statsAll.total, avgResponse24h: stats24h.avgResponse },
    checks: db.prepare("SELECT status, http_status_code AS httpStatus, response_time AS responseTime, error_message AS error, checked_at AS checkedAt FROM checks WHERE website_id = ? ORDER BY id DESC LIMIT 100").all(w.id),
    incidents: db.prepare("SELECT * FROM incidents WHERE website_id = ? ORDER BY started_at DESC LIMIT 20").all(w.id),
  });
});

app.delete("/api/websites/:id", requireLogin, (req, res) => {
  const w = myWebsite(req);
  if (!w) return bad(res, "Website not found.", 404);
  db.prepare("DELETE FROM websites WHERE id = ?").run(w.id);   // checks + incidents deleted too (ON DELETE CASCADE)
  res.json({ message: "Deleted." });
});

/* ---------- errors ---------- */
app.use("/api", (req, res) => bad(res, "Not found.", 404));
app.use((err, req, res, next) => {                              // 4 parameters = error handler
  if (err.type === "entity.parse.failed") return bad(res, "Invalid JSON.");
  console.error(err);                                            // details only in the server log
  res.status(500).json({ error: PROD ? "Something went wrong." : err.message });
});

/* ---------- start ---------- */
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`CloudPulse running at http://localhost:${port}`);
  monitor.startScheduler();
  setTimeout(() => monitor.checkAll().catch(() => {}), 2000);   // don't wait a full interval after boot
});

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
