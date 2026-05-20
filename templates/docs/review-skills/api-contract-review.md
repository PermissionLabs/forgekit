# API Contract Review

Run on any change to a public API surface — HTTP endpoints, RPC schemas,
exported SDK types, message contracts between services, or webhook
payload shapes consumed by third parties.

## Check

**Compatibility**
- Are any existing fields renamed, removed, or retyped? Each one is a
  breaking change unless the consumer is fully controlled by this repo.
- Are required fields being added? Existing clients will fail to send
  them. Either make the field optional, default it server-side, or roll a
  new version.
- Does response shape change in a way old clients can't parse?

**Versioning**
- Is the version surfaced (URL path, header, package version, message
  schema id)?
- If breaking: is the old version still served, with a documented sunset
  window?
- If non-breaking: are the changes additive only?

**Deprecation**
- Fields or endpoints being phased out are marked deprecated in the spec
  *and* in code comments / docs.
- Sunset date or condition recorded.

**Documentation**
- OpenAPI / GraphQL schema / protobuf / TypeScript types updated in the
  same change.
- Example payloads in docs match the new shape.

**Behavior contract**
- Status codes, error shapes, pagination cursor semantics, idempotency
  guarantees — any of these silently changing counts as breaking.
- Rate limits / quotas documented if changed.

**Backward compat tests**
- A test exercises a request shape from the previous version against the
  new code path, where feasible.

## Output

For each finding, record in the change record under "Review Cycles":

- endpoint / type / message name
- the issue, in one sentence; explicitly say *breaking* or *non-breaking*
- disposition: `fixed`, `filed_followup`, `accepted_with_reason`, `blocked`
- consumer migration note if disposition is `accepted_with_reason`
