# Decisions

## 2026-08-03

- Decision: Store all prices as integer pence.
  Reason: Floating point rounding broke basket totals in the prototype. Integers are exact.

- Decision: Use SvelteKit for the web app.
  Reason: Priya already knows it, and server-side rendering keeps the order form usable without JavaScript.

## 2026-08-05

- Decision: Stay on SQLite instead of Postgres for launch.
  Reason: One VPS, fewer than 200 orders a day expected, and Litestream gives continuous backups to object storage. Revisit if we pass 2,000 orders a day.

## 2026-08-07

- Decision: Use PayLoop hosted checkout instead of building our own card form.
  Reason: Keeps us out of PCI scope. Card details never touch our server.

- Decision: No customer accounts at launch, guest checkout only.
  Reason: Leo wants the fastest possible checkout. Accounts can come later with email magic links.

## 2026-08-12

- Decision: Pickup and delivery dates are stored as YYYY-MM-DD strings in shop local time.
  Reason: Timestamps caused off-by-one-day bugs around midnight.

## 2026-08-19

- Decision: Deploy with a shell script and systemd, not Docker.
  Reason: One small VPS and one service. Docker adds moving parts nobody on the team wants to maintain.

- Decision: Keep releases as folders under /srv/fernhill/releases with a current symlink.
  Reason: Rolling back is a symlink swap and a service restart.

## 2026-08-26

- Decision: Orders close at 14:00 the day before pickup.
  Reason: The bakers plan the night bake at 15:00. Later orders cannot be baked in time.

## 2026-09-02

- Decision: Free delivery over £25 inside the core postcodes, £3.50 otherwise.
  Reason: Leo's numbers show the van costs about £3 per drop outside the centre.

## 2026-09-09

- Decision: Welsh translations are done by a human translator, not machine translation.
  Reason: Fernhill has Welsh-speaking customers who complained about a machine-translated menu at another bakery.

- Decision: Menu data comes from Leo's spreadsheet as CSV, imported by a script.
  Reason: Leo already maintains prices in a spreadsheet. A full admin menu editor can wait.

## 2026-09-16

- Decision: Self-host privacy-friendly analytics on the same VPS, with no third-party trackers.
  Reason: No cookie banner needed, and no customer data leaves our server.

## 2026-09-23

- Decision: Allergen information is shown on every product card, not only on the product page.
  Reason: The accessibility audit and Leo's legal advice both said allergens must be visible before adding to the basket.

## 2026-09-30

- Decision: Refunds are issued from the admin screen only, never automatically.
  Reason: Leo wants a person to check every refund. Volumes are low.

- Decision: Order confirmation emails go through the shared SMTP relay at smtp.fernhill.example.
  Reason: The bakery already pays for it and it handles SPF and DKIM.

## 2026-10-07

- Decision: The click and collect window is 30 minutes.
  Reason: Shops can stage at most 40 orders per half hour on the collection shelf.

## 2026-10-14

- Decision: The sourdough subscription will be a weekly box that customers can pause or cancel any time.
  Reason: Leo does not want to lock customers in. Monthly billing was rejected as too complex for launch.

- Decision: Use a jobs table in SQLite for background work instead of Redis.
  Reason: Jobs are emails and PayLoop webhook retries only. A table with a worker loop is enough.

## 2026-10-21

- Decision: Block launch on the basket button contrast fix.
  Reason: It fails WCAG AA, and it is the most important button on the site.
