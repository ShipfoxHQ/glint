# VCS provider core

`@glint/api-vcs-core` owns small provider-neutral identity, namespace, installation, repository,
branch, pull-request, webhook-event, ancestry, and logical Check contracts. It has no provider SDK,
OAuth storage, SQL, or Glint role policy.

```text
provider identity (stable ID)
          |
          v
namespace access: owner | member | none     <- VCS core normalizes provider facts
          |
          v
Glint role: owner | reviewer | viewer       <- api-accounts owns this separate mapping

identity/auth  VcsIdentityProvider
namespace ACL  VcsNamespaceAccessProvider
installations  VcsInstallationProvider
webhooks       VcsWebhookProvider
```

The request-time access result is authoritative: `none` and access revocation deny that request.
Webhook revocation and removed/suspended lifecycle events update durable state; a suspended or removed
installation suspends its account. E1 authorization is App-installation-based, not collaborator-based:
a personal-repository collaborator who is not a namespace member intentionally normalizes to `none`.

GitHub and future adapters should run `vcsProviderContractTests` and
`vcsIdentityProviderContractTests` from `@glint/api-vcs-core/contract-test-kit`. No GitHub SDK,
webhook payload, token, or provider-specific casing belongs in this package.
