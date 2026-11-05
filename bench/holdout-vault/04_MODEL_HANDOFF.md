# Model Handoff

Updated by ChatGPT on 28 October 2026.

Next job: finish the slot swap. The rule agreed with Hana: a swap is only allowed if both slots are in the same week, and a bank holiday slot can only be swapped for another bank holiday slot.

Careful:
- The reminder job runs at 07:30 every day. Do not add a second schedule; it would break the one-email-per-day rule.
- The test database is reset every night at 02:00 from the anonymised export.

After the swap: overdue tool reminders, then the polytunnel half-day blocks.
