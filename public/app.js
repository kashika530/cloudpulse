// app.js : frontend logic. Talks to the server only through /api/... (see server.js).
const $ = (id) => document.getElementById(id);
let selectedId = null;   // which website's details are open
let chart = null;
let timer = null;

/* ---------- helpers ---------- */

// Escape text before inserting it into HTML, so nobody can inject scripts.
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") { showAuth(); throw new Error("Please log in."); }
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

const pct = (n) => (n === null || n === undefined ? "—" : n + "%");
const ms = (n) => (n === null || n === undefined ? "—" : n + " ms");
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}

function duration(sec) {
  if (sec === null || sec === undefined) return "—";
  if (sec < 60) return sec + " sec";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return [h && h + " h", m && m + " min"].filter(Boolean).join(" ");
}

const badge = (status, failures = 0) => {
  if (status === "UP" && failures > 0) return `<span class="badge warn">UP · ${failures} failed check</span>`;
  const label = { UP: "Up", DOWN: "Down", PENDING: "Pending", ONGOING: "Ongoing", RESOLVED: "Resolved" }[status] || status;
  return `<span class="badge ${esc(status.toLowerCase())}">${label}</span>`;
};
const tile = (label, value, sub = "") => `<div class="card tile"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
const emptyRow = (text, cols) => `<tr><td colspan="${cols}" class="empty">${text}</td></tr>`;

/* ---------- switching between login and dashboard ---------- */

function showAuth() {
  clearInterval(timer);
  $("dash-view").hidden = true;
  $("auth-view").hidden = false;
}

async function showDashboard(user) {
  $("auth-view").hidden = true;
  $("dash-view").hidden = false;
  $("who").textContent = user.name;
  if (!$("alertEmail").value) $("alertEmail").value = user.email;
  await refresh();
  clearInterval(timer);
  timer = setInterval(() => refresh().catch(() => {}), 15000);   // keep the page live
}

/* ---------- drawing the dashboard ---------- */

async function refresh() {
  const d = await api("GET", "/api/dashboard");
  const s = d.summary;

  $("tiles").innerHTML =
    tile("Websites monitored", s.total) +
    tile("Online", `<span style="color:var(--up)">${s.online}</span>`) +
    tile("Offline", `<span style="color:${s.offline ? "var(--down)" : "inherit"}">${s.offline}</span>`) +
    tile("Uptime (24h)", pct(s.overallUptime24h));

  $("sites").innerHTML =
    `<tr><th>Website</th><th>Status</th><th>Uptime 24h</th><th>Uptime all</th><th>Response</th><th>Last check</th><th></th></tr>` +
    (d.websites.length
      ? d.websites.map((w) => `<tr class="${w.id === selectedId ? "selected" : ""}">
          <td>${esc(w.url)}</td><td>${badge(w.status, w.consecutiveFailures)}</td>
          <td>${pct(w.uptime24h)}</td><td>${pct(w.uptimeAll)}</td><td>${ms(w.responseTime)}</td><td>${ago(w.lastCheckedAt)}</td>
          <td style="white-space:nowrap"><button class="btn small" data-view="${w.id}">View</button>
              <button class="btn small danger" data-delete="${w.id}">Delete</button></td></tr>`).join("")
      : emptyRow("No websites yet. Add one above.", 7));

  $("incidents").innerHTML = incidentRows(d.incidents, true);
  if (selectedId) await loadDetail(selectedId);
}

function incidentRows(list, withSite) {
  const cols = withSite ? 5 : 4;
  return `<tr>${withSite ? "<th>Website</th>" : ""}<th>Started</th><th>Recovered</th><th>Duration</th><th>Status</th></tr>` +
    (list.length
      ? list.map((i) => `<tr>${withSite ? `<td>${esc(i.url)}</td>` : ""}<td>${when(i.started_at)}</td>
          <td>${i.ended_at ? when(i.ended_at) : "—"}</td><td>${i.status === "ONGOING" ? "ongoing" : duration(i.duration_seconds)}</td>
          <td>${badge(i.status)}</td></tr>`).join("")
      : emptyRow("No incidents. One appears when a site fails 2 checks in a row.", cols));
}

async function loadDetail(id) {
  const d = await api("GET", `/api/websites/${id}`);
  $("detail").hidden = false;
  $("detail-title").textContent = d.website.url;
  $("detail-tiles").innerHTML =
    tile("Uptime (24h)", pct(d.stats.uptime24h)) +
    tile("Uptime (all time)", pct(d.stats.uptimeAll), `${d.stats.totalChecks} checks`) +
    tile("Avg response (24h)", ms(d.stats.avgResponse24h));

  $("detail-incidents").innerHTML = incidentRows(d.incidents, false);
  $("detail-checks").innerHTML =
    `<tr><th>Time</th><th>Status</th><th>HTTP</th><th>Response</th><th>Details</th></tr>` +
    (d.checks.length
      ? d.checks.slice(0, 30).map((c) => `<tr><td>${when(c.checkedAt)}</td><td>${badge(c.status)}</td>
          <td>${c.httpStatus ?? "—"}</td><td>${ms(c.responseTime)}</td><td class="muted">${esc(c.error || "")}</td></tr>`).join("")
      : emptyRow("No checks yet.", 5));

  drawChart(d.checks);
}

function drawChart(checksNewestFirst) {
  const rows = [...checksNewestFirst].reverse();          // oldest -> newest
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim(), down = css.getPropertyValue("--down").trim();
  const muted = css.getPropertyValue("--muted").trim(), line = css.getPropertyValue("--line").trim();
  if (chart) chart.destroy();
  chart = new Chart($("chart"), {
    type: "line",
    data: {
      labels: rows.map((c) => new Date(c.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })),
      datasets: [{
        data: rows.map((c) => (c.status === "UP" ? c.responseTime : null)),   // gap when the site was down
        borderColor: accent, backgroundColor: accent + "22", fill: true, tension: 0.25,
        pointBackgroundColor: rows.map((c) => (c.status === "UP" ? accent : down)),
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => (c.raw === null ? "Down" : c.raw + " ms") } } },
      scales: {
        x: { ticks: { color: muted, maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: muted, callback: (v) => v + " ms" }, grid: { color: line } },
      },
    },
  });
}

/* ---------- events (what happens when you click / submit) ---------- */

$("show-register").onclick = (e) => { e.preventDefault(); $("login-form").hidden = true; $("register-form").hidden = false; };
$("show-login").onclick = (e) => { e.preventDefault(); $("register-form").hidden = true; $("login-form").hidden = false; };

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    const user = await api("POST", "/api/login", { email: $("l-email").value, password: $("l-password").value });
    $("l-password").value = "";
    await showDashboard(user);
  } catch (err) { $("login-error").textContent = err.message; }
});

$("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("register-error").textContent = "";
  try {
    await api("POST", "/api/register", {
      name: $("r-name").value, email: $("r-email").value, password: $("r-password").value, confirmPassword: $("r-confirm").value,
    });
    $("l-email").value = $("r-email").value;
    $("register-form").hidden = true; $("login-form").hidden = false;
    $("login-error").style.color = "var(--up)";
    $("login-error").textContent = "Account created. Please log in.";
  } catch (err) { $("register-error").textContent = err.message; }
});

$("logout").onclick = async () => {
  await api("POST", "/api/logout").catch(() => {});
  selectedId = null; $("detail").hidden = true;
  showAuth();
};

$("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("add-error").textContent = "";
  try {
    await api("POST", "/api/websites", { url: $("url").value, alertEmail: $("alertEmail").value });
    $("url").value = "";
    await refresh();
    setTimeout(() => refresh().catch(() => {}), 2500);      // the first check finishes a moment later
  } catch (err) { $("add-error").textContent = err.message; }
});

// One click listener for all the View / Delete buttons in the table.
$("sites").addEventListener("click", async (e) => {
  const view = e.target.closest("[data-view]");
  const del = e.target.closest("[data-delete]");
  try {
    if (view) { selectedId = Number(view.dataset.view); await refresh(); $("detail").scrollIntoView({ behavior: "smooth" }); }
    if (del && confirm("Delete this website and all its history?")) {
      await api("DELETE", `/api/websites/${del.dataset.delete}`);
      if (selectedId === Number(del.dataset.delete)) { selectedId = null; $("detail").hidden = true; }
      await refresh();
    }
  } catch (err) { alert(err.message); }
});

/* ---------- start: are we already logged in? ---------- */
api("GET", "/api/me").then(showDashboard).catch(showAuth);
