# GitHub VCS provider

`@glint/api-vcs-github` implements the provider-neutral VCS identity, namespace,
installation, and lifecycle webhook ports for one GitHub App.

Octokit types, tokens, private keys, webhook secrets, raw payloads, and GitHub
casing remain inside this package. Consumers use only the neutral core contracts.
