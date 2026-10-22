---
name: Docker verification limits
description: Distinguish embedded Docker runner failures from standalone Linux deployment configuration problems.
---

The workspace's embedded Docker runner can build images while container exec
and Docker health checks fail with OCI `setns` execution errors. Do not remove
production readiness checks solely to make them pass in this environment.

**Why:** Local verification encountered process-launch failures even though
PostgreSQL's own startup logs showed it accepting connections.

**How to apply:** Treat image builds and Compose schema checks separately from
full runtime validation. Confirm readiness checks on a standard Linux Docker
host before claiming the standalone deployment is fully verified.
