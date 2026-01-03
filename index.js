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
const ACCOUNT_MAP = JSON.parse(process.env.ACCOUNT_MAP_JSON || "{}");
const STARLING_WEBHOOK_SHARED_SECRET = process.env.STARLING_WEBHOOK_SHARED_SECRET || "";

const ALERT_TIMES = (process.env.ALERT_TIMES || "09:00").split(",").map(s => s.trim());
const ALERT_THRESHOLD_PCT = Number(process.env.ALERT_THRESHOLD_PCT || "0.9");
const ALERT_INCLUDE_ZERO = String(process.env.ALERT_INCLUDE_ZERO || "true").toLowerCase() === "true";
const ALERT_MONTHLY_SUMMARY_TIME = process.env.ALERT_MONTHLY_SUMMARY_TIME || "09:00";

let actualInitialised = false;
let actualBudgetLoaded = false;

async function initActual() {
  try {
    if (!actualInitialised) {
      await actual.init({
        serverURL: ACTUAL_SERVER_URL,
        password: ACTUAL_PASSWORD
      });
      actualInitialised = true;
    }
    if (!actualBudgetLoaded) {
      await actual.downloadBudget(ACTUAL_BUDGET_ID);
      actualBudgetLoaded = true;
    }
    return true;
  } catch (e) {
    console.error("Actual init/download failed", e);
    return false;
  }
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
  await axios.post(
    `${HA_BASE_URL}/api/services/notify/notify`,
    { title, message, data },
    { headers: { Authorization: `Bearer ${HA_TOKEN}` } }
  );
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
  const rows = cats.map(c => {
    const m = month.categories.find(x => x.id === c.id);
    const budgeted = m?.budgeted || 0;
    const spent = m?.spent || 0;
    const available = budgeted - spent;
    const ratio = budgeted > 0 ? spent / budgeted : spent > 0 ? Infinity : 0;
    return { name: c.name, budgeted, spent, available, ratio };
  });
  const overspent = rows.filter(r => r.available < 0);
  const nearLimit = rows.filter(r => r.available >= 0 && r.ratio >= ALERT_THRESHOLD_PCT && isFinite(r.ratio));
  const zeroBudgetSpent = ALERT_INCLUDE_ZERO ? rows.filter(r => r.budgeted === 0 && r.spent > 0) : [];
  const parts = [];
  if (overspent.length) {
    parts.push(
      "Overspent: " +
        overspent
          .map(r => `${r.name} £${(r.spent / 100).toFixed(2)}/£${(r.budgeted / 100).toFixed(2)}`)
          .join(", ")
    );
  }
  if (nearLimit.length) {
    parts.push(
      "Near limit: " +
        nearLimit
          .map(r => `${r.name} £${(r.spent / 100).toFixed(2)}/£${(r.budgeted / 100).toFixed(2)}`)
          .join(", ")
    );
  }
  if (zeroBudgetSpent.length) {
    parts.push(
      "Unbudgeted spend: " +
        zeroBudgetSpent.map(r => `${r.name} £${(r.spent / 100).toFixed(2)}`).join(", ")
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
  const totalBudgeted = month.categories.reduce((s, x) => s + (x.budgeted || 0), 0);
  const totalSpent = month.categories.reduce((s, x) => s + (x.spent || 0), 0);
  const available = totalBudgeted - totalSpent;
  await notifyHA(
    `Monthly budget ${isoMonth}`,
    `Budgeted £${(totalBudgeted / 100).toFixed(2)}, spent £${(totalSpent / 100).toFixed(2)}, available £${(available / 100).toFixed(2)}`,
    { group: "actual_budget" }
  );
}

app.get("/starling-sync-health", (_req, res) => {
  res.status(200).send("ok");
});

app.post("/starling-sync-echo", async (req, res) => {
  try {
    const raw = await getRawBody(req);
    const text = raw.toString("utf8");
    res.set("content-type", "application/json").status(200).send(text);
  } catch {
    res.status(400).send("bad");
  }
});

app.get("/starling-sync-debug-actual", async (_req, res) => {
  try {
    if (!(await initActual())) {
      return res.status(500).json({ ok: false, error: "init failed" });
    }
    const accounts = await actual.getAccounts();
    res.json({ ok: true, count: accounts.length, accounts: accounts.map(a => ({ id: a.id, name: a.name })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/starling-sync-debug-env", (_req, res) => {
  const { ACTUAL_PASSWORD, HA_TOKEN, STARLING_WEBHOOK_SHARED_SECRET, ...rest } = process.env;
  res.json(rest);
});

app.post("/starling-sync-incoming-jw", async (req, res) => {
  try {
    const raw = await getRawBody(req);
    const sig = req.header("X-Hook-Signature") || "";
    if (STARLING_WEBHOOK_SHARED_SECRET) {
      const h = crypto.createHmac("sha256", STARLING_WEBHOOK_SHARED_SECRET).update(raw).digest("base64");
      if (h !== sig) {
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
      console.log("webhook error", e);
    }
  } catch (e) {
    console.log("webhook parse error", e);
    res.status(200).send("ok");
  }
});

app.post("/starling-sync-run-budget-alerts", async (_req, res) => {
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

app.listen(PORT, () => {
  console.log(`sync listening on ${PORT}`);
});
