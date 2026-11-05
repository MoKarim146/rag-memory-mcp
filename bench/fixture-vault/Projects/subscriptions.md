# Sourdough subscription

Leo wants customers to subscribe to a weekly sourdough box. Planned for after the Welsh launch.

## Agreed so far (meeting on 14 October)

- One box per week, collected or delivered on the same weekday every week.
- Customers can pause for up to four weeks or cancel any time, with no lock-in.
- The price is charged weekly through PayLoop saved cards, two days before the box is baked.
- Box contents: one large sourdough loaf plus one item that changes every week.

## Open questions

- What happens on bank holidays when the shop is closed? Leo suggested moving the box to the next open day.
- Do we need customer accounts for subscriptions? Probably yes, which reopens the guest checkout decision.

## Rough data model

- subscriptions: id, customer_email, weekday, shop_id or delivery postcode, status (active, paused, cancelled), paused_until.
- subscription_boxes: id, subscription_id, bake_date, order_id.
