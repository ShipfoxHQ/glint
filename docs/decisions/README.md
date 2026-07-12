# Architecture decisions

These records explain the supported minimum viable product topology in plain language:

1. [Application runtime and web hosting](application-runtime-and-web-hosting.md)
2. [Managed PostgreSQL](managed-postgresql.md)
3. [Private image storage](private-image-storage.md)
4. [Managed background jobs](managed-background-jobs.md)
5. [Image comparison worker](image-comparison-worker.md)
6. [Infrastructure and releases](infrastructure-and-releases.md)
7. [Application security](application-security.md)
8. [Operations and recovery](operations-and-recovery.md)

The [reference deployment](../deployment/reference-topology.md) collects the exact settings and
safety limits in one readable view. A provider or limit change requires new compatibility or
performance evidence before it becomes part of the supported topology.
