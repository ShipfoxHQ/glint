# VCS provider core

`@glint/api-vcs-core` owns repository, branch, pull-request, webhook-event, ancestry, and logical
Check contracts. Provider adapters authenticate webhooks and map them before core code sees an
event. Versioned logical Check updates prevent late work from overwriting a newer conclusion.

GitHub and future providers should run `vcsProviderContractTests` from
`@glint/api-vcs-core/contract-test-kit`. No GitHub SDK or webhook payload type belongs in this
package.
