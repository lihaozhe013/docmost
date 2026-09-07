# Repository Guidelines

## Project Context

- This repository is a personal fork of Docmost intended for private,
  self-hosted use.
- The fork is intentionally independent from upstream Docmost. Do not spend
  effort preserving compatibility with upstream behavior, APIs, internal
  structure, or future changes unless a task explicitly requires it.
- Prefer solutions that fit this repository and its actual supported use cases
  over solutions designed for hypothetical upstream integration.

## Language Requirements

- Write all new or modified code comments and documentation in English.
- Do not add Chinese characters to comments or documentation.
- This applies to inline comments, docstrings, README files, guides, design
  notes, and other repository documentation.

## File Size and Design

- When a newly added file exceeds 1,000 lines, evaluate whether its
  responsibilities should be split into smaller files or decoupled modules.
- Prefer decomposition when it improves cohesion, readability, testing, or
  maintainability. If a file remains over 1,000 lines, record the reason in
  the change description or relevant documentation.

## Product Scope

- Assume the default audience is one person or a small group running the
  project privately on their own infrastructure.
- Treat the project as open-source and non-commercial by default.
- Do not add or plan commercial product features such as billing,
  subscriptions, paid plans, feature tiers, public SaaS workflows, or
  enterprise sales functionality unless a task explicitly requests them.
- Favor simple self-hosted workflows and practical functionality for the
  default audience.

## Implementation Style

- Prefer direct implementations for the supported application behavior.
- Do not add defensive code solely for hypothetical upstream changes,
  unsupported integrations, unknown consumers, or enterprise-scale scenarios.
- Keep validation, authorization, security checks, data integrity safeguards,
  and error handling that are required by the actual application and its
  supported runtime behavior.
