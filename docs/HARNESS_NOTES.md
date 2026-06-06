# Harness Notes

Use this file to capture possible improvements to ForgeKit discovered while
working in real projects.

## Compound Loop

ForgeKit should improve through repeated real workflow friction, not speculative
rules.

When a repeated task, debugging loop, review failure, or documentation gap shows
up:

1. Fix the local project workflow first.
2. Record the pattern here.
3. Note whether it helped in practice.
4. Promote only the smallest reusable version into `templates/`.

## Upstream Candidates

Add notes here when a local workflow rule seems reusable across projects.

Suggested format:

```markdown
### YYYY-MM-DD - Short title

- Source project:
- Problem repeated:
- Local fix tried:
- Evidence it helped:
- Candidate ForgeKit change:
```

### 2026-06-06 - worktree-add refreshes root before branching

- Source project: wildfolio-root (CBDF prototype)
- Problem repeated: 루트 체크아웃이 origin 보다 뒤처진 채 방치 → worktree 가 stale
  한 *로컬* `origin/main` 추적 ref 에서 분기. "task 시작 시 최신화" 강제 지점이 없어
  루트가 표류(서브모듈 프로젝트는 포인터 dirty 까지).
- Local fix tried (이 PR 로 템플릿 반영): `scripts/worktree-add.sh` 가 분기 직전
  (1) `default_branch()`(`origin/HEAD`→폴백 main)로 default 브랜치 해석, (2) 좁힌
  `git fetch origin <default> [base]`, (3) 루트가 default 브랜치·ff 가능이면
  `git merge --ff-only origin/<default>`(pull 아님 — 방금 fetch 한 ref 에 ff,
  upstream-config 의존/하프머지 dirty 회피). default 아님/ff 불가/로컬변경이면 최신화
  skip + 경고(공유 루트 강제 yank 금지 — 격리 모델 보호).
- Evidence it helped: wildfolio-root PR #295 에서 도입, 동일 로직 e2e + 3-round 리뷰
  수렴. (서브모듈 정합 단계는 프로젝트별이라 템플릿엔 미포함 — 서브모듈 쓰는 프로젝트가
  자체 추가.)
- Candidate ForgeKit change: 본 변경이 그 promote. drift 감지 inject 경고 등 나머지
  CBDF 레이어는 별도 promote 후보로 남김.

### 2026-05-14 - bootstrap entry point

- Source project: forgekit itself
- Problem repeated: New repos miss `.context/` or `.gitignore` step when
  applying templates manually; agents re-derive the procedure from README each
  time.
- Local fix tried: Added `docs/BOOTSTRAP.md` (agent-facing primary procedure)
  and `scripts/bootstrap.sh` (deterministic shortcut). README Quick Start now
  points at both.
- Evidence it helped: Pending — first downstream application.
- Candidate ForgeKit change: Already in this repo; promote pattern (doc + thin
  script) to any future spin-off harnesses.

### 2026-05-28 - internal sync check coverage

- Source project: forgekit itself, PR #13 review.
- Problem repeated: `scripts/check-harness-sync.sh --forgekit` did not verify
  that root docs or helper scripts changed in a PR match the corresponding
  templates.
- Local fix tried: Manual root/template comparison during review; added exact
  sync checks for tracked `docs/PHASE_REFS.json`.
- Evidence it helped: Caught that the PR validation language overstated what
  the `--forgekit` command proves.
- Candidate ForgeKit change: Extend `--forgekit` mode further to verify root
  docs and helper script parity where a one-to-one template mapping exists,
  while keeping known intentional root/template differences explicit.

## Rejected Ideas

Add notes here when an idea was tested and did not improve real development.

## Project-Only Rules

Add notes here when a rule is useful locally but should not be upstreamed.
