# Security Review

Run on any change that touches authentication, authorization, secrets,
external input, data persistence, or cross-tenant boundaries. Run by
default on production-facing changes; skip only for clearly mechanical or
documentation-only diffs and record the skip reason.

## Check

**Authentication and session**
- Every new endpoint / handler asserts an authenticated identity (or is
  explicitly documented as anonymous).
- Session tokens are not logged, embedded in URLs, or returned in error
  bodies.

**Authorization**
- Every read and write path asserts the caller is allowed to touch the
  target resource (object-level, not just route-level).
- Cross-tenant boundaries: no row, file, or queue item is reachable across
  tenant/owner without a deliberate check.
- Row-Level Security (RLS) or equivalent policies are present where the
  storage engine enforces them.

**Input handling**
- External input is validated at the boundary (type, range, length).
- Strings used in SQL, shell, file paths, regex, or templates are
  parameterized / escaped — never string-concatenated.
- File uploads / downloads are scoped to safe paths and content types.

**Secrets and config**
- No secrets committed (keys, tokens, passwords, `.env` values).
- New env vars documented and added to the secrets store, not just the
  developer's shell.

**Data exposure**
- Responses include only the fields the caller is allowed to see.
- Logs do not include PII, tokens, or secrets.
- Error responses do not leak stack traces or internal IDs in production.

**Race conditions and state**
- Multi-step operations that must be atomic use a transaction, lock, or
  documented compensating action.
- Idempotency keys / dedup logic present where retries can hit the same
  endpoint twice.

**Dependencies**
- New dependencies are from a trusted source and pinned.
- No known-vulnerable versions introduced.

## Output

For each finding, record in the change record under "Review Cycles":

- file:line or system area
- the issue, in one sentence, with the threat class (e.g. *injection*,
  *missing authz*, *secret leak*)
- disposition: `fixed`, `filed_followup`, `accepted_with_reason`, `blocked`
- severity hint (`high`, `medium`, `low`) when it helps triage

A clean review is a valid result. Record the cycle anyway.
