# Fast CI Template

`harness-quality.yml` is a credential-independent starting point. Copy it into
`.github/workflows/` and provide a project-owned `scripts/test-harness.sh --ci` command. The project
entrypoint decides which optional ForgeKit modules and product checks apply; the template does not
assume private submodules, secrets, release lanes, or a particular application stack.

Third-party actions are pinned to full commit SHAs, permissions are read-only, checkout credentials are
not persisted, and concurrent runs cancel superseded work.
