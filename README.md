# CloudPulse (simple version)

Add websites, and CloudPulse checks them on a timer. After **2 failed checks in a row** it emails you once;
when the site recovers it emails you again. Dashboard shows status, uptime %, response-time chart, history and incidents.

## Run it
```bash
npm install
cp .env.example .env      # edit if you like
npm start                 # http://localhost:3000   (needs Node 22.13 or newer, Node 24 works)
```
Emails print in the terminal until you set `EMAIL_HOST` etc. in `.env`.

## Files
```
server.js        START HERE: Express, login sessions, API routes, starts the scheduler
database.js      opens SQLite + runs schema.sql
schema.sql       the 4 tables: users, websites, checks, incidents
monitor.js       checkWebsite() + the 2-failure rule (recordResult) + node-cron scheduler
email.js         down + recovery emails (Nodemailer)
public/index.html  login + dashboard (one page)
public/app.js      frontend logic + Chart.js graph
public/style.css   styling (dark mode is automatic)
.env / .env.example  settings and secrets (.env is never committed)
flaky-server.js  OPTIONAL: fake website you can switch up/down for testing
test-monitor.js  OPTIONAL: proves the 2-failure rule (npm test)
```

## Test without owning a website
1. In `.env`: `ALLOW_LOCAL_URLS=true` and `CHECK_INTERVAL=5`, then `npm start`.
2. Second terminal: `npm run flaky`.
3. Register, add `http://localhost:4000/`.
4. Open `http://localhost:4000/__down`, wait ~10 s: the DOWN email prints (once). Open `/__up`: RECOVERY email prints.

## The rule, in one table
| Check result | What happens |
|---|---|
| UP | failure counter -> 0. If an outage was open: close it, send recovery email |
| DOWN (1st) | counter = 1. No email |
| DOWN (2nd) | counter = 2. Open incident, send ONE alert |
| DOWN (3rd, 4th...) | nothing (`incident_active` is already 1) |

## Packages (5)
express · bcryptjs · express-session · nodemailer · node-cron  (+ Chart.js from a CDN in the browser)
The database is SQLite built into Node itself (`node:sqlite`), so nothing needs compiling. Node marks it "experimental"; the npm scripts hide that warning.

## Notes for production
Sessions are kept in memory (users must log in again after a restart). Set `NODE_ENV=production` and a real
`SESSION_SECRET`. Deploy on a VPS with PM2 so monitoring keeps running; SQLite needs a persistent disk.
