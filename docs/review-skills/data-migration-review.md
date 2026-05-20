# Data Migration Review

Run on any change that adds, removes, or restructures persisted data —
schema migrations, backfills, deletions, large UPDATE/INSERT batches, or
shape changes to long-lived files / blobs.

## Check

**Schema change**
- DDL is reversible (a `down` migration exists, or the rollback path is
  documented).
- Adding a NOT NULL column: paired with a default or a backfill step that
  must complete before the constraint applies.
- Dropping or renaming a column: app code stopped reading/writing it in a
  prior release, not the same release.

**Backfill**
- Backfill is chunked / paginated for tables large enough to lock.
- Backfill is idempotent — re-running mid-failure does not corrupt rows.
- Progress is observable (counter, log, dashboard) so a stuck backfill is
  noticed.

**Locking and downtime**
- Long-running migrations on hot tables use online / non-blocking
  variants where the engine supports them (e.g. Postgres
  `CREATE INDEX CONCURRENTLY`).
- Estimated lock duration is documented; the maintenance window (if any)
  is stated.

**Concurrent writes**
- App code can tolerate the intermediate state (old code reading new
  schema, new code reading old schema, both during deploy).
- Triggers / generated columns / CHECK constraints don't silently break
  in-flight writes.

**Rollback**
- Rollback procedure is concrete: SQL, command, or runbook link.
- Rollback after partial backfill leaves data in a known state (not
  half-migrated).

**Destructive ops**
- `DELETE`, `TRUNCATE`, `DROP` are gated by an explicit human approval or
  a feature flag that requires manual flip.
- A backup or PITR window is confirmed before the destructive step.

**Verification**
- Pre/post counts or checksums recorded.
- Spot-check queries written before the migration runs.

## Output

For each finding, record in the change record under "Review Cycles":

- migration / table / column name
- the issue, in one sentence
- disposition: `fixed`, `filed_followup`, `accepted_with_reason`, `blocked`
- severity hint when the issue could cause data loss or extended downtime
