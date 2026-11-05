# App Store and Play Store releases

## Process

1. Kofi tags the release in git, for example v1.3.2.
2. EAS builds both apps in the cloud.
3. Ines writes the release notes in plain language, no "bug fixes and improvements".
4. iOS goes to TestFlight for 3 days with the beta group, Android to the internal track.
5. Submit for review. Phased release on both stores, 7 days to reach everyone.

## Review notes

- Apple rejected 1.3.0 because the background location purpose string did not say why the app needs it while closed. The accepted text: "TrailMate records your hike while your phone is in your pocket, so your route is complete even with the screen off."
- For 1.4, Apple will want a video showing emergency share using location in the background.

## Version history

| Version | Date | Main change |
|---|---|---|
| 1.2 | 16 June | Supabase backend |
| 1.3 | 4 August | Subscriptions |
| 1.3.2 | 29 September | Seven-day trial, crash fixes |
| 1.4 | 24 November (planned) | Emergency share |
