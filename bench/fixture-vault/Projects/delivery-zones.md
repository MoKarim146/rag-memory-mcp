# Delivery zones

Delivery runs from the Canton shop with one van, Tuesday to Saturday, 10:00 to 16:00.

## Zones

- Core zone: CF10, CF11, CF14, CF24. Free delivery for orders over £25, otherwise £3.50.
- Outer zone: CF3, CF23. Delivery costs £3.50 for every order, with no free threshold.
- CF5 (Ely, Fairwater): not served yet. Leo is deciding whether the van can cover it on Saturdays.

## How the lookup works

The customer types a postcode. We take the outward code (the part before the space), upper-case it and look it up in the delivery_zones table. Unknown outward codes get the message "Sorry, we do not deliver there yet. You can still collect from any shop."

## Capacity

The van can do about 25 drops per day. When a day reaches 25 delivery orders, that day is greyed out in the date picker for delivery but stays open for collection.
