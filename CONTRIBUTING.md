# Contributing to Maintenance Pro

Contributions are welcome: bug reports, feature ideas and pull requests.

Maintenance Pro is **source-available**, not open source. Under the [LICENSE](LICENSE) you may fork the
repository on GitHub to prepare pull requests, but you may not redistribute, rebrand or sell the software.

## How to contribute

1. Open an issue first for anything bigger than a small fix, so the work fits the roadmap.
2. Fork the repository and create a branch.
3. Read [CLAUDE.md](CLAUDE.md) (layout, commands, conventions) and [docs/GUIDELINES.md](docs/GUIDELINES.md)
   (project rules).
4. Before opening the pull request, run:
   ```bash
   uv run ruff check mpro tests && uv run ruff format mpro tests && uv run mypy && uv run pytest
   cd frontend && npm run build
   ```
5. Open the pull request and tick the CLA box in its description (see below).

## Contributor License Agreement (CLA)

By submitting a contribution (code, documentation, designs, translations or anything else) to this
repository, you agree to the following:

1. **Your right to contribute.** The contribution is your own original work, or you otherwise have the right
   to submit it, and it does not knowingly infringe anyone's rights. If your employer has rights to work you
   create, you have its permission to contribute.
2. **Copyright license.** You grant the Maintenance Pro author (the "Licensor") a perpetual, worldwide,
   non-exclusive, royalty-free, irrevocable license to use, copy, modify, publish, distribute, sublicense and
   relicense your contribution, under any terms, including in proprietary and paid products such as
   MPro Cloud.
3. **Patent license.** You grant the Licensor and recipients of the software a perpetual, worldwide,
   royalty-free, irrevocable patent license to make, use, sell and otherwise transfer your contribution, as
   part of Maintenance Pro or any product derived from it.
4. **Your rights.** You keep the copyright in your contribution and can use it for anything else you like.
   Your contribution is credited in the git history.
5. **No obligations.** The Licensor does not have to accept, use or keep your contribution, and you do not
   have to provide support for it. You provide it "as is", without warranties.
6. **Editions.** You understand that the Licensor may include your contribution in the self-hosted edition,
   MPro Cloud, or both, and may move features between them.

Why: this lets the project change its license, offer a hosted edition and move features between the
self-hosted and cloud codebases without having to track down every past contributor.
