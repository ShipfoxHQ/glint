# Local Garage

`compose.yml` runs a single-node Garage instance for local S3-compatible object storage. It is
development-only: the committed admin token, RPC secret, and object-store credentials must never
be used in a shared or production environment.

`bootstrap.sh` assigns the local node, creates the private `glint` bucket, and grants the fixed
development key read/write access. `dev/local-stack.sh` runs it automatically.
