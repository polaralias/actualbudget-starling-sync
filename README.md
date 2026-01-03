# actualbudget-starling-sync

## Configuration

Create env with:
```bash
PORT=5007
ACTUAL_SERVER_URL=http://actual:5006
ACTUAL_PASSWORD=
ACTUAL_BUDGET_ID=
HA_BASE_URL=
HA_TOKEN=
ACCOUNT_MAP_JSON={"{starlingID}":{"actualAccountId":"{actualID}","currency":"GBP"}}

# Optional: Shared secret from Starling's Payment Services Portal
STARLING_WEBHOOK_SHARED_SECRET=

ALERT_TIMES=08:00,20:00
ALERT_THRESHOLD_PCT=0.9
ALERT_INCLUDE_ZERO=true
ALERT_MONTHLY_SUMMARY_TIME=09:00
```

## Setup & Persistence

**IMPORTANT**: To avoid losing unsynced local changes and to prevent re-downloading the budget every time the container restarts, you **must** mount a persistent volume at:
`/tmp/actual-cache`

## Security

- **Webhook Verification**: If `STARLING_WEBHOOK_SHARED_SECRET` is provided, the service verifies signatures using HMAC-SHA512.
- **Graceful Shutdown**: The service handles `SIGTERM` and `SIGINT` to ensure the Actual API shuts down cleanly.
- **No Debug Endpoints**: All debug endpoints that exposed environment data have been removed.
