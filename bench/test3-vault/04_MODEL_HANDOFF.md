# Model Handoff

Updated by Gemini on 29 October 2026.

Where we are: emergency share works on iOS end to end. On Android 15 the background task is killed after 10 minutes; the fix is a foreground service with a visible notification ("TrailMate is sharing your location"). Kofi has a branch for it: feature/android-fg-share.

Next steps:
1. Finish the Android foreground notification and test a 3-hour hike on the Pixel 7 test phone.
2. Add the Twilio retry queue: if sending fails, retry every 2 minutes for up to 30 minutes, then give up and show the user.
3. Record the review video for Apple.

Careful: the Twilio test credentials only send to the three verified test numbers. Never put real contact numbers in the test project.
