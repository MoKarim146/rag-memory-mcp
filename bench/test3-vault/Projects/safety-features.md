# Safety features

## Emergency share (release 1.4)

The hiker picks up to three contacts. One tap sends them a text message with a link to a live map of the hiker's position, updated every 2 minutes for up to 12 hours. The link works in any browser; contacts do not need the app.

- Texts go through Twilio (decision of 6 October).
- The live map page is served from our backend and shows only the last position and the trail name, not the route history.
- The link expires when the hiker stops sharing or after 12 hours.

## Android 15 problem

Android 15 stops background location for apps without a foreground service after about 10 minutes. We will show a permanent notification while sharing: "TrailMate is sharing your location".

## Ideas for later

- Automatic alert if the hiker has not moved for 2 hours (needs careful design to avoid false alarms at lunch stops).
- Offline SOS via satellite on phones that support it.
