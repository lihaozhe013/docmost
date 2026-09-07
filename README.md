# Docmost (Personal fork)

A focused, self-hosted fork of [Docmost](https://docmost.com) for private use
by one person or a small group of family, friends, or colleagues. The project
is intended to be deployed on infrastructure controlled by its users. It is
free, open-source, and non-commercial by default, and it is not intended to
become a public hosted service or a general enterprise distribution.

## Project direction

This fork is built around a simple operating model: a small trusted group runs
one private instance for its own documents and collaboration. The project
therefore prioritizes useful pages, real-time editing, search, sharing, and
straightforward administration over features designed for public SaaS
operations or commercial product management.

Account management follows the same idea. An administrator creates accounts
and resets passwords directly, so the deployment does not need a reachable
mailbox, SMTP service, public registration, or a customer-facing onboarding
system. An email address is used as a sign-in identifier, but it does not need
to deliver mail.

The default product scope deliberately excludes billing, subscriptions, paid
plans, feature tiers, trials, license sales, public signup funnels, and other
commercial workflows. Enterprise features such as SSO, MFA, SCIM, audit
systems, and large-organization governance are also outside the default goal
unless a concrete local use case requires them.

## Relationship with upstream

This repository started as a fork of Docmost, but it is maintained as an
independent project with its own scope and priorities. It is intentionally not
a compatibility layer or a synchronization project for upstream Docmost.

There is no requirement to preserve upstream APIs, internal extension points,
feature coverage, architecture, or merge friendliness. Upstream changes may be
adopted when they are useful to this project, but they do not define the
direction of this fork. When upstream assumptions conflict with the needs of a
private self-hosted deployment, the local project scope takes priority.

## Development principles

- Implement the supported local workflows directly and keep the resulting code
  easy to understand and operate.
- Avoid defensive code, compatibility layers, and fallback paths that exist
  only for hypothetical upstream changes, unsupported integrations, unknown
  consumers, or enterprise-scale deployments.
- Keep the safeguards required by the actual application, including
  authorization, security checks, input validation, data integrity, and useful
  error handling.
- If a newly added file grows beyond 1,000 lines, evaluate whether its
  responsibilities should be split into smaller files or decoupled modules.

## What changed compared to upstream

Removed:

- Email / SMTP integration (invitations, password reset, email notifications)
- Workspace invitation flow (invite links, pending invites)
- Cloud-only code: billing/Stripe, license page, cloud login, trials
- Enterprise-gated UI and features: SSO, MFA, SCIM, API keys, audit logs & SIEM,
  page verification, templates, personal spaces, bases, PDF export, OAuth apps,
  confluence/docx/pdf imports (server still enforces license gates on these)
- "Forgot password" flow

Added:

- **Admin-managed accounts**: an owner/admin creates a member by
  name/email/role; the server generates a one-time random password shown only to
  the admin. The member signs in with it and changes it in Account settings.
  (`POST /api/workspace/members/create`)
- **Admin password reset**: an owner/admin can reset any member's password,
  which signs the member out of all sessions. The new one-time password is shown
  only to the admin. (`POST /api/workspace/members/reset-password`)

Kept:

- Real-time collaboration (Yjs)
- Pages, spaces, groups, comments (including comment resolution), page history
- Public share links (`/share/...`)
- Search, attachments, embeds, diagrams
- In-app notifications
- AI-related client scaffolding (AI settings/chat UI) so future AI work can
  build on it

## Getting started

### Prerequisites

- Docker and Docker Compose
- PostgreSQL and Redis are bundled in `docker-compose.yml`

### Deploy

1. Copy `.env.example` to `.env` and set a strong `APP_SECRET`, `DATABASE_URL`
   and `REDIS_URL` (see the compose file for defaults).
2. Run:

```bash
docker compose up -d
```

3. Open `http://localhost:3000`, complete the initial setup (`/setup/register`)
   which creates the workspace owner.
4. Create accounts for other people: Workspace settings → Members → **Create
   member**. Share the one-time password with the member outside of Docmost
   (chat, phone, etc.) — it cannot be retrieved later.
5. Members change their password at Account → My profile → Change password.

### Notes

- Sign-in uses the email address as the username. It does not need to be a
  reachable mailbox (e.g. `zhangsan@local.dm` works fine).
- There is no self-registration and no "forgot password" — lost passwords are
  reset by an admin.
- Public share links work out of the box; disable sharing at the page level in
  the share popover when needed.

## Development

```bash
pnpm install
pnpm dev          # starts client (vite) and server (nest) with watch
```

Build:

```bash
pnpm build        # or: pnpm server:build && pnpm client:build
```

The server needs PostgreSQL and Redis running; point `DATABASE_URL` and
`REDIS_URL` at them.

## License

The original Docmost core is AGPL-3.0. This fork retains that license for the
derived code. Removed upstream enterprise files are not part of this
distribution.
