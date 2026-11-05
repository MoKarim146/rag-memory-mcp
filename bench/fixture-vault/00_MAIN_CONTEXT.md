# Main Context

Fake demo memory for the token benchmark. Everything here is invented: the bakery, the people, the hostnames and the numbers.

## Project

Fernhill Bakery runs three shops (Canton, Roath and the Market stall). We are building an online pre-order system so customers can order bread and cakes the day before and collect them, or get them delivered inside Cardiff.

- Client: Leo Marsh, owner of Fernhill Bakery.
- Team: Tomasz (backend), Priya (design and frontend), Mina (QA, part time), Anna (validation rules and content).
- AI assistants: Claude, ChatGPT and Gemini share this memory through the MCP server. Each one writes a session note under Sessions/.

## Stack

- Frontend: SvelteKit, server-side rendered, with progressive enhancement so ordering works without JavaScript.
- API: Node.js 22 with Fastify, in the same repository (monorepo with apps/web and apps/api).
- Database: SQLite in WAL mode. See the decision log for why not Postgres.
- Payments: PayLoop hosted checkout, with webhooks into /api/payloop/webhook.
- Hosting: one VPS (4 GB RAM) behind Caddy. Staging runs on the same box under a different systemd unit.

## Conventions

- Money is always integer pence in code and in the database. Format only at the edge.
- Pickup and delivery dates are local dates stored as YYYY-MM-DD strings, never timestamps.
- Every pull request needs one review and green CI. Main is deployed by hand with scripts/deploy.sh.
- Copy is written in British English. Welsh copy goes through the translator, never machine translation.
- Do not put real customer data in this memory.

## Where things live

- Projects/ holds one note per workstream: payments, deployment, delivery zones, accessibility, menu import, Welsh language, subscriptions and analytics.
- Meetings/ holds notes from the weekly call with Leo.
- Reference/ holds the glossary, the style guide and the on-call runbook.
- Sessions/ holds assistant session notes, newest at the bottom of each file.
