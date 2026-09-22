#!/usr/bin/env bash
# Cron entrypoint (hermes cron --no-agent --script) for the WhatsApp bulk dispatcher.
# Runs every minute; sends the earliest DUE scheduled message. Stdout is silenced so
# the cron job stays "silent" (no delivery attempt) — see dispatch.log for activity.
node /opt/data/skills/send-whatsapp-bulk/scripts/bulk.js dispatch >/dev/null 2>&1 || true
