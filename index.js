import express from "express";
import getRawBody from "raw-body";
import axios from "axios";
import * as actual from "@actual-app/api";
import crypto from "crypto";
import cron from "node-cron";

const app = express();
app.disable("x-powered-by");

const PORT = process.env.PORT || 5007;
const ACTUAL_SERVER_URL = process.env.ACTUAL_SERVER_URL;
const ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD || "";
const ACTUAL_BUDGET_ID = process.env.ACTUAL_BUDGET_ID;
const HA_BASE_URL = process.env.HA_BASE_URL || "";
const HA_TOKEN = process.env.HA_TOKEN || "";
const STARLING_WEBHOOK_SHARED_SECRET = process.env.STARLING_WEBHOOK_SHARED_SECRET || "";

const ALERT_TIMES = (process.env.ALERT_TIMES || "09:00").split(",").map(s => s.trim());
const ALERT_THRESHOLD_PCT = Number(process.env.ALERT_THRESHOLD_PCT || "0.9");
const ALERT_INCLUDE_ZERO = String(process.env.ALERT_INCLUDE_ZERO || "true").toLowerCase() === "true";
const ALERT_MONTHLY_SUMMARY_TIME = process.env.ALERT_MONTHLY_SUMMARY_TIME || "09:00";

let ACCOUNT_MAP = {};
try {
  ACCOUNT_MAP = JSON.parse(process.env.ACCOUNT_MAP_JSON || "{}");
} catch (e) {
  console.error("FATAL: Failed to parse ACCOUNT_MAP_JSON. Check your environment variables.");
  process.exit(1);
}

let initPromise = null;

async function initActual() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await actual.init({
      dataDir: "/tmp/actual-cache",
      serverURL: ACTUAL_SERVER_URL,
      password: ACTUAL_PASSWORD
    });

    await actual.downloadBudget(ACTUAL_BUDGET_ID);
    return true;
  })().catch(e => {
    console.error("Actual init/download failed", e?.stack || e);
    initPromise = null;
    return false;
  });

  return initPromise;
}

function toMinor(amountCurrency) {
  if (typeof amountCurrency === "number") return Math.round(amountCurrency);
  if (amountCurrency && typeof amountCurrency.minorUnits === "number") return Math.round(amountCurrency.minorUnits);
  return 0;
}

function starlingToActualTx(feedItem, actualAccountId) {
  const signedMinor = toMinor(feedItem.amount) * (feedItem.direction === "OUT" ? -1 : 1);
  const date = (feedItem.transactionTime || feedItem.eventTimestamp || new Date().toISOString()).slice(0, 10);
  const payee =
    feedItem.counterPartyName ||
    feedItem.merchantName ||
    feedItem.reference ||
    feedItem.narrative ||
    "Starling";
  return {
    account: actualAccountId,
    date,
    amount: signedMinor,
    payee_name: payee,
    imported_payee: feedItem.reference || "",
    notes: feedItem.source || "",
    imported_id: feedItem.feedItemUid
  };
}

async function notifyHA(title, message, data = {}) {
  if (!HA_BASE_URL || !HA_TOKEN) return;
  try {
    await axios.post(
      `${HA_BASE_URL}/api/services/notify/notify`,
      { title, message, data },
      { headers: { Authorization: `Bearer ${HA_TOKEN}` } }
    );
  } catch (e) {
    console.error("Failed to send HA notification", e.message);
  }
}

async function handleEvent(ev) {
  if (!(await initActual())) return;
  const accountUid = ev?.content?.accountUid || ev?.accountUid;
  const item = ev?.content?.feedItem || ev?.content?.feedItemEvent || ev?.content || ev;
  if (!accountUid || !item) {
    console.log("event ignored: missing accountUid or item");
    return;
  }
  const map = ACCOUNT_MAP[accountUid];
  if (!map) {
    console.log("no account mapping for", accountUid);
    return;
  }
  const tx = starlingToActualTx(item, map.actualAccountId);
  const result = await actual.importTransactions(map.actualAccountId, [tx]);
  console.log("import result", result);

  // CRITICAL: Sync after import to persist changes
  await actual.syncBudget();

  if ((result.added && result.added.length) || (result.updated && result.updated.length)) {
    const amt = (tx.amount / 100).toFixed(2);
    await notifyHA("Actual updated from Starling", `${tx.date} ${tx.payee_name} £${amt}`, {
      group: "actual_budget",
      importance: "high"
    });
  }
}

async function runBudgetAlerts(forMonthIso) {
  if (!(await initActual())) return;
  const isoMonth = forMonthIso || new Date().toISOString().slice(0, 7);
  const cats = await actual.getCategories();
  const month = await actual.getBudgetMonth(isoMonth);
  if (!month) return;

  const rows = cats.map(c => {
    const m = month.categories.find(x => x.id === c.id);
    const budgeted = m?.budgeted || 0;
    // Actual API returns spent as negative for spending
    const spent = m?.spent || 0;
    const available = budgeted + spent; // Corrected sign (budgeted is +, spent is -)
    const ratio = budgeted > 0 ? (Math.abs(spent) / budgeted) : (spent < 0 ? Infinity : 0);
    return { name: c.name, budgeted, spent, available, ratio };
  });

  const overspent = rows.filter(r => r.available < 0);
  const nearLimit = rows.filter(r => r.available >= 0 && r.ratio >= ALERT_THRESHOLD_PCT && isFinite(r.ratio));
  const zeroBudgetSpent = ALERT_INCLUDE_ZERO ? rows.filter(r => r.budgeted === 0 && r.spent < 0) : [];
  const parts = [];

  if (overspent.length) {
    parts.push(
      "Overspent: " +
        overspent
          .map(r => `${r.name} £${(Math.abs(r.spent) / 100).toFixed(2)}/£${(r.budgeted / 100).toFixed(2)}`)
          .join(", ")
    );
  }
  if (nearLimit.length) {
    parts.push(
      "Near limit: " +
        nearLimit
          .map(r => `${r.name} £${(Math.abs(r.spent) / 100).toFixed(2)}/£${(r.budgeted / 100).toFixed(2)}`)
          .join(", ")
    );
  }
  if (zeroBudgetSpent.length) {
    parts.push(
      "Unbudgeted spend: " +
        zeroBudgetSpent.map(r => `${r.name} £${(Math.abs(r.spent) / 100).toFixed(2)}`).join(", ")
    );
  }
  if (parts.length) {
    await notifyHA(`Budget alerts ${isoMonth}`, parts.join(" | "), { group: "actual_budget" });
  }
}

async function runMonthlySummary() {
  if (!(await initActual())) return;
  const isoMonth = new Date().toISOString().slice(0, 7);
  const month = await actual.getBudgetMonth(isoMonth);
  if (!month) return;

  const totalBudgeted = month.categories.reduce((s, x) => s + (x.budgeted || 0), 0);
  const totalSpent = month.categories.reduce((s, x) => s + (x.spent || 0), 0);
  const available = totalBudgeted + totalSpent; // Corrected sign

  await notifyHA(
    `Monthly budget ${isoMonth}`,
    `Budgeted £${(totalBudgeted / 100).toFixed(2)}, spent £${(Math.abs(totalSpent) / 100).toFixed(2)}, available £${(available / 100).toFixed(2)}`,
    { group: "actual_budget" }
  );
}

app.get("/starling-sync-health", (_req, res) => {
  res.status(200).send("ok");
});

app.post("/starling-sync-incoming", async (req, res) => {
  try {
    const raw = await getRawBody(req);
    const sig = req.header("X-Hook-Signature") || "";

    if (STARLING_WEBHOOK_SHARED_SECRET) {
      // Use SHA-512 as per Starling documentation for Payment Services
      const h = crypto.createHmac("sha512", STARLING_WEBHOOK_SHARED_SECRET).update(raw).digest("base64");
      
      // Use timingSafeEqual to prevent timing attacks
      const hBuf = Buffer.from(h, "utf8");
      const sigBuf = Buffer.from(sig, "utf8");
      
      if (hBuf.length !== sigBuf.length || !crypto.timingSafeEqual(hBuf, sigBuf)) {
        console.log("signature mismatch");
        return res.status(401).send("invalid signature");
      }
    }

    const body = JSON.parse(raw.toString("utf8"));
    res.status(200).send("ok");
    console.log("webhook received");
    try {
      await handleEvent(body);
    } catch (e) {
      console.log("webhook processing error", e);
    }
  } catch (e) {
    console.log("webhook parse error", e);
    res.status(200).send("ok");
  }
});

app.post("/starling-sync-run-alerts", async (_req, res) => {
  try {
    await runBudgetAlerts();
    res.status(200).send("ok");
  } catch (e) {
    res.status(500).send("error");
  }
});

function scheduleAt(hhmm, fn) {
  const [h, m] = hhmm.split(":").map(x => parseInt(x, 10));
  const expr = `${m} ${h} * * *`;
  cron.schedule(expr, fn, { timezone: "Europe/London" });
}

for (const t of ALERT_TIMES) {
  scheduleAt(t, () => {
    runBudgetAlerts().catch(() => {});
  });
}

scheduleAt(ALERT_MONTHLY_SUMMARY_TIME, () => {
  const d = new Date();
  if (d.getDate() === 1) {
    runMonthlySummary().catch(() => {});
  }
});

const server = app.listen(PORT, () => {
  console.log(`sync listening on ${PORT}`);
});

async function shutdown() {
  console.log("Shutting down gracefully...");
  try {
    await actual.shutdown();
    console.log("Actual API shut down.");
  } catch (e) {
    console.error("Error during Actual shutdown", e);
  }
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });
  // Force exit after 10s if logic gets stuck
  setTimeout(() => process.exit(1), 10000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
