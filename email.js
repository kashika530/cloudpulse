// email.js : sends the two emails (DOWN alert, RECOVERY).
// If EMAIL_HOST is empty, the email is printed in the terminal instead. Handy for testing.
const nodemailer = require("nodemailer");

const transporter = process.env.EMAIL_HOST
  ? nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT) || 587,
      secure: Number(process.env.EMAIL_PORT) === 465,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
    })
  : null;

const time = (iso) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: process.env.TIMEZONE || "UTC", dateStyle: "medium", timeStyle: "short" });

function duration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return [h && `${h} hour${h === 1 ? "" : "s"}`, m && `${m} minute${m === 1 ? "" : "s"}`].filter(Boolean).join(" ");
}

async function send(to, subject, text) {
  if (!transporter) {
    console.log(`\n[EMAIL - not configured, printing instead]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    return;
  }
  await transporter.sendMail({ from: process.env.EMAIL_FROM, to, subject, text });
}

function sendDownAlert(website, failures, startedAt, problem) {
  return send(website.alert_email, "🚨 Website Down Alert", [
    "Your website appears to be unavailable.", "",
    `Website: ${website.url}`,
    `Failed checks: ${failures} consecutive failures`,
    `Problem: ${problem || "No response"}`,
    `Outage began: ${time(startedAt)}`,
    `Detected: ${time(new Date().toISOString())}`, "",
    "Please check your website/server.",
  ].join("\n"));
}

function sendRecoveryAlert(website, endedAt, seconds) {
  return send(website.alert_email, "✅ Website Recovered", [
    "Your website is available again.", "",
    `Website: ${website.url}`,
    `Downtime: ${duration(seconds)}`,
    `Recovered: ${time(endedAt)}`,
  ].join("\n"));
}

module.exports = { sendDownAlert, sendRecoveryAlert };
