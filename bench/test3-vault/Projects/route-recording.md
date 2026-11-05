# Route recording

The app records a route as a list of points (latitude, longitude, altitude, time). Recording keeps running with the screen off.

## Battery budget

Target: under 5 percent battery per hour on a 2022 mid-range phone (our test phones are a Pixel 6a and an iPhone SE 2022).

How we stay inside it:

- GPS sampling every 5 seconds while moving, every 30 seconds when the hiker has not moved more than 10 metres.
- Points are written to the phone's SQLite database in batches of 20, not one by one.
- No map redraws while the screen is off.

Measured on 3 October: 3.8 percent per hour on the Pixel 6a, 4.4 percent on the iPhone SE.

## Accuracy

Points with a horizontal accuracy worse than 50 metres are dropped. Altitude comes from the barometer when the phone has one, because GPS altitude can be off by 30 metres.

## Export

Routes can be exported as a route file (GPX under the hood). The main screens never say "GPX".
