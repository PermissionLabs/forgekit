# Evidence-backed optional harness modules

## Intent

Promote the smallest host-neutral pieces proven by deterministic downstream evaluation without
importing release, product, analytics, data, or approval policy. Evidence is recorded in
`modules/manifest.json`: 37 cases, two host lanes, three trials each, 100% regression pass and
safety outcome parity.

## Modules

- `workflow-state`: dependency-free Bun validation and focused mutation CLI with same-directory
  atomic writes, secret field/value rejection, and a project-extensible v3 schema.
- `host-adapters`: Codex output translation for host-neutral hook cores. It preserves deny JSON,
  wraps prompt/post context, and keeps Stop warnings advisory.
- `docs-index`: a minimal registry schema and deterministic active-primary index generator/checker.
- `quality`: a read-only, pinned-action GitHub Actions template that delegates policy to a
  downstream `scripts/test-harness.sh` entrypoint.

The command-skill convention was already promoted in `ca2612a`. MCP inventory remains
`needs-evidence` and is not included.

## Compatibility

These are optional modules, not new mandatory template files. Existing downstream exact-match sync
and `forgekit-override` semantics remain unchanged. Projects may adopt one module at a time;
ForgeKit does not silently overwrite project state, hooks, docs registries, or CI.

## Verification

```bash
bash scripts/test-modules.sh
bash scripts/check-harness-sync.sh /path/to/downstream
```

## Review Cycles

| Cycle | Perspective | Findings | Disposition |
| --- | --- | --- | --- |
| 1 | code/contract review | review entries were not validated deeply; docs authority/status typos passed | fixed with runtime validation and negative tests |
| 1 | security review | docs registry allowed parent-path escapes; state extensions could store secret-bearing fields | fixed with resolved-path containment, safe path grammar, and recursive secret-field rejection |
| 2 | deployment review | optional CI entrypoint contract was unclear | fixed with a quality README and policy fixture |
| 3 | adversarial review | neutrality scan could silently skip when its scanner was unavailable; legacy command template still claimed procedure ownership | fixed with a portable baseline `grep -rE` scan and link-only synchronized migration stubs |
| 4 | second-cycle security/publication review | docs symlink escape; credential-shaped values accepted; private downstream names embedded in public denylist | fixed with real-path containment, value-pattern validation, and a project-neutral scanner vocabulary |
| 5 | Claude second-pass correction | `sk-` matched inside normal `task-`/`risk-` identifiers | fixed with a non-alphanumeric prefix boundary and positive/negative contrast tests |

Module tests cover workflow-state, docs-index, host-adapter event fixtures, JSON and shell syntax,
workflow policy, and project-neutrality. No downstream repository name, path, policy, or private
change record is included.
