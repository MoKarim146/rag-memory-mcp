# Runbook

## Backend down

1. Check the Supabase status page and our own uptime monitor.
2. The app keeps working offline; only uploads, sharing and emergency share need the backend.
3. If emergency share is affected, post a banner in the app through the remote config flag "emergency_notice".

## Twilio failures

Check the Twilio console for failed messages. Error 21610 means the contact has replied STOP and cannot be texted again from our sender.

## Rotating secrets

The Supabase service key and the RevenueCat webhook secret are rotated every 6 months, or immediately after anyone leaves the team.
