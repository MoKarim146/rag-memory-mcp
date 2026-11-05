# Decisions

## 2026-03-10

- Decision: Build the app with React Native and Expo.
  Reason: Kofi knows React, and Expo builds both stores from one codebase without a Mac for every developer.

- Decision: Use Firebase for authentication and the database.
  Reason: Fastest way to a working prototype; the free tier covers the beta.

## 2026-03-24

- Decision: Use MapTiler for map tiles.
  Reason: Cheapest offline-friendly vector tiles we found for the prototype.

## 2026-04-14

- Decision: Minimum supported versions are iOS 15 and Android 10.
  Reason: Covers 96 percent of the beta testers' phones.

- Decision: Self-host Sentry for crash reports on the backend server.
  Reason: Crash reports contain coordinates; we do not want them on a third-party service.

## 2026-05-12

- Decision: TrailMate Plus has a 14-day free trial.
  Reason: Hikers plan trips on weekends; two weekends felt right.

## 2026-06-02

- Decision: Move from Firebase to Supabase, hosted in the Frankfurt region.
  Reason: Firebase pricing grew with reads of trail data, and we want Postgres with PostGIS for route queries. Frankfurt keeps personal data in the EU.

- Decision: Move from MapTiler to Mapbox for map tiles.
  Reason: Mapbox offline packs are smaller (about 40 percent less storage for the same region) and the SDK handles download resume.

## 2026-06-30

- Decision: Raise the minimum iOS version to iOS 16.
  Reason: The Mapbox SDK version we need dropped iOS 15 support.

## 2026-07-14

- Decision: Use RevenueCat for subscriptions on both stores.
  Reason: One API for receipts on iOS and Android, and webhooks for our backend.

- Decision: Prices are £3.99 a month or £24.99 a year for TrailMate Plus.
  Reason: In line with competing hiking apps; the yearly plan saves about half.

## 2026-08-11

- Decision: Routes recorded by users are private by default.
  Reason: Several beta testers recorded routes that start at their front door.

## 2026-09-08

- Decision: Shorten the free trial from 14 days to 7 days.
  Reason: Trial users who did not convert in the first week almost never converted later, and the long trial attracted people who only needed one weekend.

- Decision: Keep the monthly price, raise the yearly price to £29.99.
  Reason: The yearly plan was 80 percent of sign-ups and underpriced against costs.

## 2026-10-06

- Decision: Emergency share sends text messages through Twilio, not push notifications.
  Reason: Contacts may not have the app installed, and SMS works with weak signal.

## 2026-10-20

- Decision: Release 1.4 ships on 24 November, without the weather warnings if they are not ready.
  Reason: Emergency share is the feature hikers asked for most; weather can follow in 1.4.1.
