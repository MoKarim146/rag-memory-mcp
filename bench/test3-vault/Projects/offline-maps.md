---
tags: [project, maps]
---
# Offline maps

Hikers download a region before the trip. A region is a Mapbox offline pack with vector tiles from zoom 8 to zoom 15, plus our trail overlay.

## Sizes

| Region | Pack size | Trails |
|---|---|---|
| Lake District | 182 MB | 1,240 |
| Snowdonia | 141 MB | 890 |
| Peak District | 126 MB | 1,010 |
| Scottish Highlands (north) | 410 MB | 2,300 |

The Highlands pack is too big for many phones, so it is split into north and south.

## Download rules

- Downloads only start on Wi-Fi unless the user switches on "Download on mobile data".
- Interrupted downloads resume where they stopped; the Mapbox SDK keeps partial tiles.
- Packs expire after 90 days and are refreshed in the background when the phone is on Wi-Fi and charging.

## Known problems

- On Android, a download of more than 300 MB sometimes stalls at 99 percent. Workaround: we split big regions.
- The app does not yet show the download size before starting. Task added on 27 October.

## History

The prototype used MapTiler. We moved to Mapbox in June because the offline packs were about 40 percent smaller for the same region.
