// test-monitor.js : OPTIONAL. Proves the two-failure rule works.   Run:  node test-monitor.js
const os = require("os"), path = require("path"), assert = require("assert");
process.env.DATABASE_PATH = path.join(os.tmpdir(), `cp-test-${Date.now()}.db`);   // throw-away database
const db = require("./database");
const { runCheck } = require("./monitor");

db.prepare("INSERT INTO users (name,email,password_hash) VALUES ('T','t@t.com','x')").run();
const UP = { status: "UP", httpStatus: 200, responseTime: 100, error: null };
const DOWN = { status: "DOWN", httpStatus: null, responseTime: null, error: "timeout" };

// Plays a list of results through the monitor and reports which emails "would be sent".
async function scenario(name, results, expectedEmails, expectedIncidents) {
  const info = db.prepare("INSERT INTO websites (user_id,url,alert_email) VALUES (1,?,'o@o.com')").run("https://x.test/" + name);
  const site = db.prepare("SELECT * FROM websites WHERE id=?").get(info.lastInsertRowid);
  const sent = [];
  const mailer = { sendDownAlert: async () => sent.push("DOWN"), sendRecoveryAlert: async () => sent.push("RECOVERY") };
  const queue = [...results];
  for (let i = 0; i < results.length; i++) await runCheck(site, async () => queue.shift(), mailer);
  const incidents = db.prepare("SELECT COUNT(*) n FROM incidents WHERE website_id=?").get(site.id).n;
  assert.deepStrictEqual(sent, expectedEmails, name + ": emails");
  assert.strictEqual(incidents, expectedIncidents, name + ": incidents");
  console.log("PASS", name, "->", sent.join(", ") || "no emails");
}

(async () => {
  await scenario("always-up", [UP, UP, UP], [], 0);
  await scenario("fails-once-then-up", [UP, DOWN, UP], [], 0);              // must NOT alert
  await scenario("fails-twice", [UP, DOWN, DOWN], ["DOWN"], 1);
  await scenario("stays-down", [DOWN, DOWN, DOWN, DOWN, DOWN], ["DOWN"], 1); // only ONE email
  await scenario("down-then-recovers", [DOWN, DOWN, DOWN, UP], ["DOWN", "RECOVERY"], 1);
  await scenario("up-down-repeatedly", [DOWN, DOWN, UP, DOWN, UP, DOWN, DOWN, UP], ["DOWN", "RECOVERY", "DOWN", "RECOVERY"], 2);
  console.log("\nAll scenarios passed.");
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
