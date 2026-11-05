# Menu import

Leo keeps the menu in a spreadsheet. He exports it as CSV and we import it with scripts/import-menu.ts.

## CSV columns

sku,name,price_pence,allergens,shop_ids,available_days

- price_pence is an integer, for example 350 for £3.50.
- allergens is a list of codes separated by semicolons: G gluten, M milk, E egg, N nuts, S sesame, SO soya.
- shop_ids is a list of shop codes: CAN (Canton), ROA (Roath), MKT (Market stall).
- available_days uses Mon,Tue and so on, and is empty for every day.

## Rules

- Always run with --dry-run first. It prints what would change and exits.
- Products missing from the CSV are hidden, never deleted, so old orders still show their items.
- A price change only affects new orders. Existing orders keep the price they were placed at.

## Known problems

- Leo's spreadsheet sometimes exports prices with a pound sign. The importer strips the £ and rejects anything with a decimal point.
- Seasonal products (hot cross buns, Christmas stollen) need start and end dates. Not supported yet.
