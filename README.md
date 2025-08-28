# cc-auto-commit

A lightweight helper for composing concise, high-signal Git commit messages from your changes. The goal is to reduce friction in your commit workflow by auto-generating a summary you can drop into your commit message.

## Current features

- **AI-generated summary using `codex`**: Produces a short, readable summary of your staged changes/diff using a `codex`-based backend. This is the only provider supported right now.

## Roadmap / upcoming

- **Optional `Claude Code` provider**: Add the option to generate the summary with `Claude Code` as an alternative to `codex`.
- **Provider abstraction**: Pluggable LLM providers with simple configuration and easy fallbacks.
- **Configuration**: Friendly config via environment variables and/or a project config file.

## Status

Early-stage and evolving. Interfaces and defaults may change.

## License

This project is licensed under the terms of the LICENSE file in this repository.
