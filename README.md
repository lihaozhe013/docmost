# Docmost (Personal fork)

A trimmed, self-hosted fork of [Docmost](https://docmost.com) for private use among
family, friends and colleagues. It is free for everyone and is not intended for
public signups.

This fork diverges from upstream on purpose: enterprise/cloud features, email
(SMTP) delivery, and license-gated surfaces have been removed, and user
provisioning is done by an administrator.

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

- **Admin-managed accounts**: an owner/admin creates a member by name/email/role;
  the server generates a one-time random password shown only to the admin. The
  member signs in with it and changes it in Account settings.
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

3. Open `http://localhost:3000`, complete the initial setup
   (`/setup/register`) which creates the workspace owner.
4. Create accounts for other people: Workspace settings → Members →
   **Create member**. Share the one-time password with the member outside of
   Docmost (chat, phone, etc.) — it cannot be retrieved later.
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