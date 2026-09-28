# Aegion (Legion Engine) Repository Setup and Entry Points

## Overview

This repository is a `pnpm` monorepo for the Legion Engine platform. In this repo, **Aegion** is the repository name and **Legion Engine** is the platform/runtime name for the same codebase.

Canonical naming convention for contributors:

- Use **Aegion** when referring to the GitHub repository, clone path, and branch/PR context.
- Use **Legion Engine** when referring to the runtime system and architecture.
- Use `@legion/*` when referring to workspace package names in commands/imports.

It is organized into:

- `apps/*` for runnable application surfaces (API and dashboards)
- `packages/*` for shared logic and platform modules
- `scripts/` for root-level operational tooling
- `docs/` for architecture, API, state-machine, and schema specifications

Package naming follows the `@legion/*` convention across the workspace.

Workspace definition: `pnpm-workspace.yaml`

---

## Prerequisites

- Node.js `>=20.0.0`
- pnpm `>=9.0.0`

Source: `package.json` (`engines.node`, `engines.pnpm`, and `packageManager`)

---

## Initial Setup

From repository root:

1. Install dependencies
   - `pnpm install`
2. Create env files as needed
   - root API/runtime config: copy `.env.example` to `.env`
   - dashboard config (if running dashboard app): copy `apps/dashboard/.env.example` to `apps/dashboard/.env`
   - sovereign admin config (if running `@legion/sovereign-admin`): copy `packages/sovereign-admin/.env.example` to `packages/sovereign-admin/.env.local`
   - optional package-local templates also exist (for example `packages/core/.env.example`)
   - fill required values (database, redis, auth, telegram, API keys, etc.)

Env file convention:

- `.env` / `apps/dashboard/.env` are standard runtime env files for Node/Vite flows.
- `.env.local` is used for the Next.js app (`packages/sovereign-admin`) local overrides.
3. Optional database steps
   - `pnpm db:generate`
   - `pnpm db:migrate`
   - these root commands proxy to `@legion/core` Drizzle tasks and are only needed for DB-backed API workflows

---

## Development and Build Commands

Root command entry points are in `package.json`.
All commands in this section are workspace commands and should be run from the repository root.

### Core runtime

- `pnpm dev`
  - Runs `scripts/dev.js`
  - Builds `@legion/core`, then starts `@legion/api` in watch mode

### Frontend/admin

- `pnpm dev:dashboard` → runs `@legion/dashboard`
  - Target app: `apps/dashboard` (Vite dev server)
- `pnpm dev:vault` → runs `@legion/sovereign-admin`
  - Target package/app: `packages/sovereign-admin` (Next.js dev server)

### Build

- `pnpm build` (core + API)
- `pnpm build:all` (clean lock artifacts, then full ordered build across packages and apps)
- `pnpm build:workspace` (ordered build pass only, without the clean pre-step)

### Quality and tests

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

---

## Repository Organization

High-signal workspace areas are listed below. For the authoritative full workspace membership, check `pnpm-workspace.yaml`.

### Applications (`apps/`, selected)

- `apps/api` — Fastify backend API (primary backend runtime)
- `apps/dashboard` — React/Vite campaign dashboard
- `apps/master-dashboard` — React/Vite dashboard shell

### Packages (`packages/`, selected)

- `packages/core` — shared core logic, chains, security, routing, state
- `packages/sentinels` — sentinel module exports
- `packages/sdk` — public SDK surface
- `packages/mirror` — mirror health/rotation module
- `packages/updater` — live config updater module
- `packages/sovereign-admin` — Next.js admin app package

---

## Key Entry Points

### Root-level entry points

- `package.json` (all root scripts)
- `scripts/dev.js` (main local dev bootstrap)

### API runtime entry points

- `apps/api/src/index.ts`
  - boot orchestration, startup/shutdown, background cron start
- `apps/api/src/server.ts`
  - Fastify creation, middleware registration, route registration
- `apps/api/src/app.ts`
  - CORS ingress/origin policy registration

### High-signal API route entry points (good first reads for health, telemetry, jobs, and auth flows)

- `apps/api/src/routes/health.ts`
- `apps/api/src/routes/stats.ts`
- `apps/api/src/routes/scout.ts`
- `apps/api/src/routes/jobs.ts`
- `apps/api/src/routes/auth.ts`

### Dashboard entry points

- `apps/dashboard/src/main.tsx`
- `apps/dashboard/src/App.tsx`
- `apps/dashboard/src/api.ts`

### Master dashboard entry points

- `apps/master-dashboard/src/main.tsx`
- `apps/master-dashboard/src/App.tsx`

### Sovereign admin (Next.js) entry points

- `packages/sovereign-admin/package.json`
- `packages/sovereign-admin/next.config.mjs`
- `packages/sovereign-admin/src/app/layout.tsx`
- `packages/sovereign-admin/src/app/page.tsx`
- `packages/sovereign-admin/src/app/dashboard/page.tsx`
- `packages/sovereign-admin/src/middleware.ts`

### Package module entry points

- `packages/core/src/index.ts`
- `packages/sentinels/src/index.ts`
- `packages/sdk/src/index.ts`
- `packages/mirror/src/index.ts`
- `packages/updater/package.json` (`main`/`exports` define updater package entry mappings)

---

## Recommended Reading Path

Start with these stable files, then continue through the **Key Entry Points** section above:

1. `README.md`
2. `package.json`
3. `apps/api/src/index.ts`
4. `apps/api/src/server.ts`
5. `packages/core/src/index.ts`
