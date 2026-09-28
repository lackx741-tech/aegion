# Aegion Repository Setup and Entry Points

## Overview

This repository is a `pnpm` monorepo for the Legion Engine platform. It is organized into:

- `apps/*` for runnable application surfaces (API and dashboards)
- `packages/*` for shared logic and platform modules
- `scripts/` for root-level operational tooling
- `docs/` for architecture, API, state-machine, and schema specifications

Note on naming: the GitHub repository is `aegion`, while many workspace packages and runtime modules use the `@legion/*` naming convention.

Workspace definition: `pnpm-workspace.yaml`

---

## Prerequisites

- Node.js `>=20.0.0`
- pnpm `>=9.0.0`

Source: `package.json`

---

## Initial Setup

From repository root:

1. Install dependencies
   - `pnpm install`
2. Create env files as needed
   - copy `.env.example` to `.env`
   - add runtime values (database, redis, auth, telegram, api keys, etc.)
3. Optional database steps
   - `pnpm db:generate`
   - `pnpm db:migrate`

---

## Development and Build Commands

Root command entry points are in `package.json`.

### Core runtime

- `pnpm dev`
  - Runs `scripts/dev.js`
  - Builds `@legion/core`, then starts `@legion/api` in watch mode

### Frontend/admin

- `pnpm dev:dashboard` → runs `@legion/dashboard`
- `pnpm dev:vault` → runs `@legion/sovereign-admin`

### Build

- `pnpm build` (core + API)
- `pnpm build:all` (workspace-wide ordered build)
- `pnpm build:workspace` (workspace package build pass)

### Quality and tests

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

---

## Repository Organization

### Applications (`apps/`)

- `apps/api` — Fastify backend API
- `apps/dashboard` — React/Vite campaign dashboard
- `apps/master-dashboard` — React/Vite dashboard shell
- `apps/pancakeswap-clone` — Vite app surface
- `apps/phantom-wallet` — wallet-focused React/Vite app

### Packages (`packages/`)

- `packages/core` — shared core logic, chains, security, routing, state
- `packages/sentinels` — sentinel module exports
- `packages/sdk` — public SDK surface
- `packages/mirror` — mirror health/rotation module
- `packages/updater` — live config updater module
- `packages/sovereign-admin` — Next.js admin app package

---

## Full Entry-Point Map (Most Important)

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

### High-signal API route entry points

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
- `packages/sovereign-admin/src/app/layout.tsx`
- `packages/sovereign-admin/src/app/page.tsx`
- `packages/sovereign-admin/src/app/dashboard/page.tsx`

### Package module entry points

- `packages/core/src/index.ts`
- `packages/sentinels/src/index.ts`
- `packages/sdk/src/index.ts`
- `packages/mirror/src/index.ts`
- `packages/updater/index.ts`

---

## Recommended Reading Path

1. `README.md`
2. `package.json`
3. `apps/api/src/index.ts`
4. `apps/api/src/server.ts`
5. `apps/api/src/routes/health.ts`
6. `apps/dashboard/src/App.tsx`
7. `packages/core/src/index.ts`
8. `docs/API-SPEC.md`
9. `docs/STATE-MACHINE.md`
10. `docs/DB-SCHEMA.md`
