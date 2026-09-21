// database.js : opens the SQLite file and creates the tables.
// Uses the SQLite that is BUILT INTO Node (node:sqlite), so there is nothing extra to install or compile.
// It is synchronous: db.prepare("...").get() just returns the answer (no await).
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const db = new DatabaseSync(process.env.DATABASE_PATH || path.join(__dirname, "cloudpulse.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");   // SQLite only enforces foreign keys if you ask
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));

// A transaction = several database changes that all succeed together, or all get undone.
// Usage:  db.transaction(() => { ...changes... })();
db.transaction = (fn) => () => {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
};

module.exports = db;
