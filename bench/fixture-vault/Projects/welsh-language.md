# Welsh language

The site launches in English and Welsh. Customers pick the language with a toggle in the header; the choice is remembered in a cookie that holds only the language code.

## How translations work

- Strings live in locales/en.json and locales/cy.json. Keys are dotted paths like checkout.pay_button.
- Anna exports missing keys with npm run i18n:missing and sends them to the translator, Gwen Morgan, as a spreadsheet.
- No machine translation, see the decision of 9 September.

## Status

- Checkout and basket: translated and merged.
- Allergen labels: with the translator, expected back 6 November.
- Email templates: with the translator, expected back 6 November.

## Notes

- Welsh strings are often longer than English ones. The pay button needed a wider minimum width.
- Dates in Welsh use the month names from Intl.DateTimeFormat with the cy locale. Checked by Gwen.
