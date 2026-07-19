# Deferred tenancy and projects work

- Evaluate `FORCE ROW LEVEL SECURITY` across all tenant tables (accounts and projects) together; today both use `ENABLE` and require a non-owner runtime role.
- Add a privileged account-less token-digest resolution path for token authentication.
- Widen the project DTO visibility contract when a public project route is introduced.
- Add an idempotency-record expiry sweep; the current migration only indexes `expires_at` for it.
