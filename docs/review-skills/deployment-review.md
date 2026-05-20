# Deployment Review

Run on any change to deployment config, infrastructure-as-code, rollout
strategy, environment variables, secrets references, CI/CD pipelines, or
container/runtime config.

## Check

**Environment and secrets**
- New env vars documented; values present in every environment that will
  run this code (dev, staging, prod).
- Secrets stored in the secrets manager, not committed; access policies
  scoped to the runtime identity.
- Default values are safe — no test/dev defaults reaching production.

**Rollout strategy**
- Is the change deployed gradually (canary, percentage, regions) or
  all-at-once? Match the risk: schema / auth / payment paths should not
  go out at 100% immediately.
- Feature flags documented: default state, rollout plan, who owns the
  flip.
- Backward compatibility during rollout: a mixed fleet of old + new
  versions can coexist for the rollout window.

**Observability**
- New code paths emit logs / metrics / traces sufficient to detect
  failure within the rollout window.
- Existing alerts still fire for the new shape (e.g. error-rate alerts
  not silenced by a renamed metric).
- Dashboards updated when KPIs or graph queries depend on changed fields.

**Rollback**
- Rollback procedure is concrete and tested in principle (revert + deploy
  vs. config flip vs. flag flip).
- Time-to-rollback is acceptable for the blast radius. Schema-coupled
  changes need an extra step; document it.

**Resource and cost**
- New infra (queues, buckets, instances, autoscaling settings) sized
  appropriately; cost impact noted if material.
- IAM / network rules scoped to least privilege.

**CI/CD pipeline changes**
- Build/test steps still run on the affected branches.
- New deploy steps fail closed (a missing secret or config aborts the
  deploy rather than silently using a default).

## Output

For each finding, record in the change record under "Review Cycles":

- pipeline stage, environment, or resource name
- the issue, in one sentence
- disposition: `fixed`, `filed_followup`, `accepted_with_reason`, `blocked`
- rollback impact note when the finding affects time-to-rollback
