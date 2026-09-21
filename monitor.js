// monitor.js : the heart of CloudPulse.
//   1. checkWebsite(url)   -> ask a website "are you alive?"
//   2. recordResult(...)   -> save the answer + the 2-failure rule + emails
//   3. startScheduler()    -> node-cron runs it all on a timer
const cron = require("node-cron");
const db = require("./database");
const email = require("./email");

const TIMEOUT = Number(process.env.REQUEST_TIMEOUT) || 10000;
const THRESHOLD = Number(process.env.FAILURE_THRESHOLD) || 2;

/* ---------- 1. THE CHECKER ---------- */

// Turn Node's technical error into a sentence a human understands.
function describeError(err) {
  if (err.name === "AbortError") return `Timed out after ${TIMEOUT} ms`;
  const code = err.cause?.code || err.cause?.errors?.[0]?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS failure (domain not found)";
  if (code === "ECONNREFUSED") return "Connection refused";
  return `Could not connect (${code || err.message})`;
}

// Never throws. Always returns { status, httpStatus, responseTime, error }.
async function checkWebsite(url) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT); // give up after TIMEOUT ms
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { "User-Agent": "CloudPulse/1.0" } });
    const responseTime = Date.now() - started;
    try { await res.body?.cancel(); } catch {}          // we only need the status code
    if (res.status >= 200 && res.status < 400) {
      return { status: "UP", httpStatus: res.status, responseTime, error: null };
    }
    // The server answered, but with an error (404, 500 ...): not healthy.
    return { status: "DOWN", httpStatus: res.status, responseTime, error: `HTTP ${res.status} ${res.statusText}`.trim() };
  } catch (err) {
    return { status: "DOWN", httpStatus: null, responseTime: null, error: describeError(err) };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 2. THE TWO-FAILURE RULE ---------- */

// Saves a check result and decides whether an email is needed.
// `mailer` can be replaced in tests.
async function recordResult(site, result, mailer = email) {
  const now = new Date().toISOString();
  let toSend = null;

  // A transaction = all these database changes succeed together, or none do.
  db.transaction(() => {
    const w = db.prepare("SELECT * FROM websites WHERE id = ?").get(site.id);
    if (!w) return; // deleted while we were checking

    db.prepare(
      "INSERT INTO checks (website_id, status, http_status_code, response_time, error_message, checked_at) VALUES (?,?,?,?,?,?)"
    ).run(w.id, result.status, result.httpStatus, result.responseTime, result.error, now);

    if (result.status === "UP") {
      // Recovery: only if an outage was really declared.
      if (w.incident_active) {
        const inc = db.prepare("SELECT * FROM incidents WHERE website_id = ? AND status = 'ONGOING' ORDER BY id DESC LIMIT 1").get(w.id);
        if (inc) {
          const seconds = Math.max(0, Math.round((Date.parse(now) - Date.parse(inc.started_at)) / 1000));
          db.prepare("UPDATE incidents SET ended_at = ?, duration_seconds = ?, status = 'RESOLVED' WHERE id = ?").run(now, seconds, inc.id);
          toSend = { type: "RECOVERY", endedAt: now, seconds };
        }
      }
      // A single failure followed by UP lands here too: counter resets, no incident, no email.
      db.prepare("UPDATE websites SET status='UP', consecutive_failures=0, failure_started_at=NULL, incident_active=0, last_checked_at=? WHERE id=?")
        .run(now, w.id);
    } else {
      const failures = w.consecutive_failures + 1;
      const startedAt = w.failure_started_at || now;   // when this streak of failures began
      let status = w.status === "DOWN" ? "DOWN" : (w.status === "PENDING" ? "PENDING" : "UP");
      let active = w.incident_active;

      if (failures >= THRESHOLD) {
        status = "DOWN";
        if (!active) {                                  // first time crossing the threshold in this outage
          db.prepare("INSERT INTO incidents (website_id, started_at, status, error_message) VALUES (?,?,'ONGOING',?)").run(w.id, startedAt, result.error);
          active = 1;
          toSend = { type: "DOWN", failures, startedAt, problem: result.error };
        }
        // if active was already 1 we do nothing, which is how repeat emails are prevented
      }
      db.prepare("UPDATE websites SET status=?, consecutive_failures=?, failure_started_at=?, incident_active=?, last_checked_at=? WHERE id=?")
        .run(status, failures, startedAt, active, now, w.id);
    }
  })();

  // Email AFTER the transaction. If email breaks, monitoring data stays correct.
  if (toSend) {
    try {
      if (toSend.type === "DOWN") await mailer.sendDownAlert(site, toSend.failures, toSend.startedAt, toSend.problem);
      else await mailer.sendRecoveryAlert(site, toSend.endedAt, toSend.seconds);
    } catch (err) {
      console.error(`[email] could not send ${toSend.type} email for ${site.url}: ${err.message}`);
    }
  }
  return toSend ? toSend.type : null;
}

// Check ONE website and record it. Never throws.
async function runCheck(site, checker = checkWebsite, mailer = email) {
  try {
    const result = await checker(site.url);
    await recordResult(site, result, mailer);
    return result;
  } catch (err) {
    console.error(`[monitor] problem checking ${site.url}: ${err.message}`);
  }
}

// Check EVERY website at the same time. allSettled = one failure can't stop the others.
async function checkAll() {
  const sites = db.prepare("SELECT * FROM websites").all();
  await Promise.allSettled(sites.map((s) => runCheck(s)));
  return sites.length;
}

/* ---------- 3. THE SCHEDULER ---------- */

// node-cron wants a "cron expression", not seconds. Convert CHECK_INTERVAL (seconds):
//   30  -> "*/30 * * * * *"  (every 30 seconds)      300 -> "*/5 * * * *"  (every 5 minutes)
function toCron(seconds) {
  if (seconds < 60) return `*/${[1, 2, 5, 10, 15, 20, 30].reduce((a, b) => (Math.abs(b - seconds) < Math.abs(a - seconds) ? b : a))} * * * * *`;
  return `*/${Math.min(59, Math.round(seconds / 60))} * * * *`;
}

let running = false;
function startScheduler() {
  const expression = toCron(Number(process.env.CHECK_INTERVAL) || 300);
  cron.schedule(expression, async () => {
    if (running) return;                 // don't overlap if the last round is still going
    running = true;
    try {
      const n = await checkAll();
      if (n) console.log(`[monitor] checked ${n} website(s)`);
    } finally {
      running = false;
    }
  });
  console.log(`[monitor] scheduler started (${expression})`);
}

module.exports = { checkWebsite, recordResult, runCheck, checkAll, startScheduler };
