# Accessibility check

Lucia tested Sprout on 1 September with a screen reader, with the phone font size set to the largest setting, and on a 2017 Android phone.

Findings:

- The rota calendar's free-slot colour failed contrast. Fixed by darkening the green.
- The one-time code field did not announce errors to screen readers. Fixed with an aria-live region.
- Tap targets in the tool list were 32 pixels high; raised to 48 pixels.
- Pages loaded in 9 seconds on 3G because of an unoptimised hero photo. Now 2.5 seconds after compressing it.
