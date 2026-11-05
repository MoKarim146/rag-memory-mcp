# Server runbook

- SSH in as the `sprout` user; root login is disabled.
- The app runs as a systemd service called `sprout-web`. Logs: `journalctl -u sprout-web`.
- The reminder job is a systemd timer, `sprout-reminders.timer`, set to 07:30 daily.
- Restoring the database: use the hosting provider's snapshot from the previous night, then rerun migrations with `alembic upgrade head`.
- Disk alert at 85 percent. Uploaded photos are the main thing that grows.
