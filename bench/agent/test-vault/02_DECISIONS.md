# Decisions

## 2026-03-02

- Decision: Send booking emails through Mailgun.
  Reason: The free tier covers our volume.

- Decision: Run background jobs on RabbitMQ.
  Reason: Sam already runs RabbitMQ for the old website, so there is nothing new to operate.

## 2026-04-01

- Decision: Open at 7:00 on weekdays.
  Reason: Early climbers asked for it, and 7:00 still lets the setters work the evening before.

## 2026-05-10

- Decision: Send booking emails through Postmark.
  Reason: Mailgun's shared addresses sent confirmations to spam.
  Supersedes: 2026-03-02

## 2026-06-25

- Decision: Open at 6:00 on weekdays. (added by AI via MCP)
  Reason: More bookings could fit before work.
