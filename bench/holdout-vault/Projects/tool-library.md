---
tags: [project, tools]
status: in-progress
---
# Tool library

The shed holds about 40 shared tools. Each tool has a QR sticker on the handle; scanning it opens the tool's page in Sprout.

## Loan rules

- A loan lasts seven days and can be renewed once (see [[02_DECISIONS]]).
- Power tools (the hedge trimmer and the rotavator) can only be borrowed by members who have done the safety induction.
- A member can hold at most three tools at the same time.

## Overdue reminders

Not built yet. Plan: on day 8 the borrower gets one email; on day 10 a committee member is told. The email goes out with the daily reminder job at 07:30 so we never send two emails in one day.

## Data

| Table | Purpose |
|---|---|
| tools | name, category, photo, needs_induction |
| loans | tool_id, member_id, borrowed_at, due_at, returned_at |
| inductions | member_id, tool_category, done_on, trainer |

> [!note]
> The rotavator is out for repair until mid-November. Mark it unavailable rather than deleting it.
