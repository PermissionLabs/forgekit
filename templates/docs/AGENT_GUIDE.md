# Agent Guide

This file is the shared entry point for coding agents working in this repository.

## Operating Principle

This is a human-led, agent-assisted development workflow.

The agent should help clarify scope, implement focused changes, review its own work, and surface risks. The agent should not expand the product direction, architecture, or task scope without explicit user approval.

## Default Workflow

For code changes:

1. Read the relevant project instructions before editing.
2. Inspect nearby code before changing it.
3. State the intended change briefly when the work is non-trivial.
4. Make the smallest focused change that satisfies the request.
5. Review the diff before the final response.
6. Report what was verified and what was not verified.

## Planning Mode

Use planning mode before implementation when the request is broad, ambiguous, architectural, product-defining, or likely to affect multiple modules.

In planning mode:

- ask up to three high-leverage questions when needed
- identify the smallest useful milestone
- propose a concrete plan
- wait for confirmation before implementation when the user has asked to move step by step

## Scope Control

- Do not make broad refactors unless explicitly requested.
- Do not add frameworks, services, or dependencies without clear need.
- Do not solve adjacent problems unless they block the requested work.
- Preserve user changes and avoid reverting work you did not make.

## Review Checklist

Before final response after a code change:

- inspect changed files
- check for accidental unrelated edits
- run relevant tests or explain why they were not run
- mention residual risks or assumptions

## Harness Evolution

If this harness itself needs improvement during real project work:

- apply project-specific changes in `docs/PROJECT_CONTEXT.md`
- record reusable harness improvements in `docs/HARNESS_NOTES.md`
- promote only repeated, reusable patterns to the shared harness

