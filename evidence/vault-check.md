# Vault feasibility check (PayPal sandbox, 2026-11-04)

Question: can an agent pay later without the buyer approving each purchase?

| Step | Result |
|---|---|
| Create $1.00 order with `payment_source.paypal.attributes.vault` (`store_in_vault: ON_SUCCESS`, `usage_type: MERCHANT`) | Accepted. This sandbox app needs no extra permission. |
| Buyer checkout | PayPal shows a consent: "agree to let Test Store charge your account for future payments" |
| Consent click | PayPal asks for the buyer password again, even inside an active session. This happened on both attempts. |
| Capture (order 7BT2259196529884N) | HTTP 201, COMPLETED, `vault_status: VAULTED`, payment token returned, customer id returned |

**Conclusion:** supported. After one explicit buyer consent with a fresh login, PayPal issues a reusable payment token, so the merchant can charge later purchases with no buyer present. Per-purchase buyer approval then disappears, which is the strongest case for an independent gate: the gate becomes the only check between the agent and the money.

**Handling:** the token value was never printed, logged or saved. The script reports only `has_token_id: true`. The vaulted permission lives on the sandbox buyer account and can be revoked in its PayPal settings.

**Not built:** unattended purchases using the vaulted token. The demo stays on buyer-approved checkout, as the brief specifies.
