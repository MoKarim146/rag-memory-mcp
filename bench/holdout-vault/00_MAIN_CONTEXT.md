---
tags: [context, garden]
aliases: [Main context]
---
# Main Context

Fake demo memory for the held-out benchmark. Everything is invented.

Riverside Community Garden has 64 allotment plots, a shared polytunnel and a tool shed. We are replacing the paper sign-up sheets and the WhatsApp group with a small web app called **Sprout**.

## What Sprout does

- Plot holders book watering rotas, borrow tools and report problems.
- The committee publishes news and work-party dates.
- New members join the waiting list online instead of on paper at the gate.

## Team

- [[Hana Okafor]]: committee chair and product owner.
- [[Dev Raman]]: volunteer developer, backend.
- [[Lucia Ferreira]]: volunteer developer, frontend and accessibility.
- Several AI assistants keep notes in Sessions/.

## Stack

| Part | Choice | Notes |
|---|---|---|
| Frontend | Astro with a few Preact islands | Mostly static pages, works on old phones |
| Backend | Python, FastAPI | Runs on the committee's small cloud VM |
| Database | Postgres 16 | Managed by the hosting provider, daily snapshots |
| Auth | Email one-time codes | No passwords to forget |
| Hosting | One VM, 2 vCPU, 2 GB RAM | Paid from the garden's grant |

## Rules of thumb

- Everything must work on a cheap Android phone over 3G, because many plot holders are retired and use old phones.
- No tracking and no ads. The garden committee is strict about this.
- Plain language in the interface, reading age 9 to 11.
