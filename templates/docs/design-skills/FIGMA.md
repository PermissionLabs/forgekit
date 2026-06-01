# Figma Design Skill

Use this document when a task includes a Figma URL, Figma node ID, design QA
request, or asks to implement a UI from a design.

## Trigger

If the user provides a Figma link or says the work depends on Figma:

1. Read this document before implementation.
2. Load or invoke the host's Figma/design implementation skill if available.
   Examples: `figma-implement-design`, `figma-use`, `/figma`, or a project-local
   Figma command.
3. Keep ForgeKit workflow state current while using the external skill.
4. Record durable design decisions, mismatches, and verification in
   `docs/changes/*.md`.

ForgeKit remains the source of truth for workflow gates. Figma skills are
execution aids.

## Modes

### Implementation

Use when building a new screen, component, or visual state from Figma.

Required flow:

1. Extract the Figma node ID from the URL.
   - `node-id=123-456` becomes `123:456`.
2. Capture or request the Figma reference image when the host supports it.
3. Extract design context through the available Figma tool or skill.
   - Capture colors, typography, spacing, layout, assets, variants, and
     annotations.
4. Inspect the existing code and design system before editing.
5. Implement the smallest scoped change that matches the design.
6. Compare the implemented result against the Figma reference.
7. Iterate until the mismatch list is empty or explicitly accepted.
8. Run the relevant project checks and record what was verified.

### Design QA

Use when the task asks for QA, annotation review, or design/code mismatch
analysis.

Required flow:

1. Extract the Figma node ID.
2. Inspect the node hierarchy and annotations when available.
3. Classify issues by typography, color, spacing, layout, component behavior,
   assets, and copy.
4. Separate clear fixes from questions.
5. Ask before changing ambiguous or product-significant behavior.
6. Record QA findings in `docs/changes/*.md` or `docs/audits/*.md`.

## Implementation Rules

- Use exact design values when the project allows it.
- Prefer project design tokens and component patterns when they already encode
  the Figma value.
- Do not approximate colors, spacing, typography, or asset shape when exact
  design data is available.
- Do not add real data fetching, navigation, business logic, or new product
  behavior unless the user requested it.
- Do not keep localhost or temporary Figma asset URLs in runtime code.
- If asset extraction is needed, store the final asset in the project asset
  system and document the source.
- If Figma tools fail, check the URL/node ID and ask the human to open or grant
  access to the relevant file. Do not guess from memory.
- Non-layout visual effects (blur, shadow, backdrop) are frequently dropped by
  codegen/metadata, and their units rarely map 1:1 across target stacks — e.g. a
  CSS `blur(24px)` is not a native blur "intensity" of 24. Read each effect value
  explicitly from the design context and convert it using the project's
  unit-mapping notes in `docs/PROJECT_CONTEXT.md`, instead of copying the raw
  number across.

## Visual Verification

For frontend work, verify with the strongest available check:

- browser or simulator screenshot comparison
- component/story screenshot
- local app render inspection
- manual visual checklist when automated rendering is unavailable

Record:

- Figma node or URL
- implementation target
- known mismatches
- screenshots or QA notes when applicable
- checks run and skipped checks

## Project Customization

Project-specific Figma rules belong in `docs/PROJECT_CONTEXT.md`, for example:

- design system token mapping
- icon extraction pattern
- asset storage paths
- required screenshot tooling
- platform-specific safe area or status bar rules
- command names such as `/figma`
