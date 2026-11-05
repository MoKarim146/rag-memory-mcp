# Decisions

## 2026-06-02

- Decision: Use email one-time codes for login, no passwords.
  Reason: Older plot holders kept forgetting passwords on the old system. A six-digit code by email is easier.

- Decision: Build the frontend with Astro.
  Reason: Most pages are static and Astro ships almost no JavaScript, which matters on old phones.

## 2026-06-16

- Decision: Use Postgres, not SQLite.
  Reason: The hosting provider offers managed Postgres with daily snapshots, and Dev did not want to manage backups himself.

## 2026-07-07

- Decision: Tool loans last seven days and can be renewed once.
  Reason: The committee wants tools back in the shed for the weekend work parties.

- Decision: The waiting list is ordered by the date people joined, with no exceptions.
  Reason: Fairness complaints about the paper list, where some names were moved up.

## 2026-08-04

- Decision: Watering rota slots are two hours long, from 06:00 to 22:00.
  Reason: Eight slots a day is enough in summer and stops people booking the whole evening.

## 2026-09-01

- Decision: Send no more than one reminder email per person per day.
  Reason: Plot holders complained that the old WhatsApp reminders were too noisy.

- Decision: Photos of problems (broken fences, pests) are resized to 1280 pixels and stripped of location data before saving.
  Reason: Phone photos contain GPS location, and some members do not want their home location stored.

## 2026-10-06

- Decision: The polytunnel can be booked in half-day blocks only.
  Reason: Shorter bookings made the heater schedule impossible to manage.

## 2026-10-20

- Decision: Keep the WhatsApp group running until March 2027 alongside Sprout.
  Reason: Hana does not want to lose members who are slow to move to the new app.
