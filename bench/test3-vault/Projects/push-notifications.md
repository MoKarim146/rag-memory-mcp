# Push notifications

We send very few notifications on purpose.

- "Your offline region expires in 7 days" (only if the user has not opened it for 60 days).
- "Your friend shared a route with you".
- Nothing marketing. Ines vetoed promotional pushes.

Notifications go through Expo's push service. Tokens are stored in Supabase in the push_tokens table and deleted after 90 days without a successful delivery.

Emergency share does not use push notifications; see the decision of 6 October.
