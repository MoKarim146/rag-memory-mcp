# Accessibility audit

Audit run by Mina on staging on 23 September 2026 against WCAG 2.2 AA, using a screen reader, keyboard only and an automated checker.

## Findings

1. The "Add to basket" button has a contrast ratio of 3.1:1 (white text on light green). WCAG AA needs 4.5:1 for normal text. Fix: use Fernhill green #2F5D3A for the button background, which gives 7.9:1.
2. The date picker has no visible focus outline when using the keyboard. Fix: add a 3px outline in the focus colour.
3. Allergen icons had no text alternative. Fixed on 25 September: each icon now has a visually hidden label.
4. The order summary updates without telling screen reader users. Fixed: the total is in an aria-live polite region.
5. Error messages on the checkout form were only shown in red. Fixed: each error now has an icon and text, and focus moves to the first error.

## Status

Findings 3, 4 and 5 are fixed. Finding 1 blocks launch and is in review. Finding 2 is open.
