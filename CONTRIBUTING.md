# Contributing to SkyBOT Mint

Thank you for your interest in improving SkyBOT Mint. This guide explains how to propose changes.

By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground Rules

- **Security first.** Never add code that sends, stores, or logs raw private keys, seed phrases, or secrets. Key material must stay inside Privy. Report vulnerabilities privately (see [SECURITY.md](SECURITY.md)), not in issues or pull requests.
- **No secrets in commits.** Use `.env` (gitignored). `.env.example` must contain placeholders only.
- **Keep it multi-user safe.** Every database query must be scoped to the authenticated user. Add a test when you add a route.

## Development Setup

```bash
npm ci
cp .env.example .env      # fill in at least Privy + Telegram for full flows
npm run build
npm run dev               # web + API on http://localhost:3000
npm run dev:worker        # Telegram polling + local scheduler (separate terminal)
```

## Before You Open a Pull Request

Run the same checks as CI:

```bash
npm run typecheck
npm run lint            # must pass with zero warnings
npm run format:check    # or `npm run format` to fix
npm test
npm run build
```

## Pull Request Guidelines

1. Fork the repository and create a branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep pull requests focused. One logical change per PR.
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
4. Add or update tests for behavior changes, especially auth, scoping, signing, and scheduling.
5. Update documentation (`README.md`, `DEPLOY.md`, `.env.example`) when you change configuration or user-facing behavior.
6. Add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
7. All user-facing text must be in clear, professional English. Use Title Case for headings, buttons, and table headers, and sentence case for body text and messages.

## Code Style

- TypeScript (strict). ESLint and Prettier configs live in the repository root.
- New source files start with `// SPDX-License-Identifier: AGPL-3.0-only`.
- Prefer small, pure functions in `server/src/core/**`. Keep I/O at the edges.

## Licensing of Contributions

SkyBOT Mint is licensed under **AGPL-3.0-only**. By submitting a contribution, you agree that it is licensed under the same terms.
