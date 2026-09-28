# Aegion Repository Setup and Entry Points

## Overview

This repository is a `pnpm` monorepo for the Legion Engine platform. It is organized into:

- `apps/*` for runnable application surfaces (API and dashboards)
- `packages/*` for shared logic and platform modules
- `scripts/` for root-level operational tooling
- `docs/` for architecture, API, state-machine, and schema specifications

Workspace definition: `/home/runner/work/aegion/aegion/pnpm-workspace.yaml`

---

## Prerequisites

- Node.js `>=20.0.0`
- pnpm `>=9.0.0`

Source: `/home/runner/work/aegion/aegion/package.json`

---

## Initial Setup

From repository root:

1. Install dependencies
   - `pnpm install`
2. Create env files as needed
   - copy `/home/runner/work/aegion/aegion/.env.example` to `.env`
   - add runtime values (database, redis, auth, telegram, api keys, etc.)
3. Optional database steps
   - `pnpm db:generate`
   - `pnpm db:migrate`

---

## Development and Build Commands

Root command entry points are in `/home/runner/work/aegion/aegion/package.json`.

### Core runtime

- `pnpm dev`
  - Runs `/home/runner/work/aegion/aegion/scripts/dev.js`
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

- `/home/runner/work/aegion/aegion/apps/api` — Fastify backend API
- `/home/runner/work/aegion/aegion/apps/dashboard` — React/Vite campaign dashboard
- `/home/runner/work/aegion/aegion/apps/master-dashboard` — React/Vite dashboard shell
- `/home/runner/work/aegion/aegion/apps/pancakeswap-clone` — Vite app surface
- `/home/runner/work/aegion/aegion/apps/phantom-wallet` — wallet-focused React/Vite app

### Packages (`packages/`)

- `/home/runner/work/aegion/aegion/packages/core` — shared core logic, chains, security, routing, state
- `/home/runner/work/aegion/aegion/packages/sentinels` — sentinel module exports
- `/home/runner/work/aegion/aegion/packages/sdk` — public SDK surface
- `/home/runner/work/aegion/aegion/packages/mirror` — mirror health/rotation module
- `/home/runner/work/aegion/aegion/packages/updater` — live config updater module
- `/home/runner/work/aegion/aegion/packages/sovereign-admin` — Next.js admin app package

---

## Full Entry-Point Map (Most Important)

### Root-level entry points

- `/home/runner/work/aegion/aegion/package.json` (all root scripts)
- `/home/runner/work/aegion/aegion/scripts/dev.js` (main local dev bootstrap)

### API runtime entry points

- `/home/runner/work/aegion/aegion/apps/api/src/index.ts`
  - boot orchestration, startup/shutdown, background cron start
- `/home/runner/work/aegion/aegion/apps/api/src/server.ts`
  - Fastify creation, middleware registration, route registration
- `/home/runner/work/aegion/aegion/apps/api/src/app.ts`
  - CORS ingress/origin policy registration

### High-signal API route entry points

- `/home/runner/work/aegion/aegion/apps/api/src/routes/health.ts`
- `/home/runner/work/aegion/aegion/apps/api/src/routes/stats.ts`
- `/home/runner/work/aegion/aegion/apps/api/src/routes/scout.ts`
- `/home/runner/work/aegion/aegion/apps/api/src/routes/jobs.ts`
- `/home/runner/work/aegion/aegion/apps/api/src/routes/auth.ts`

### Dashboard entry points

- `/home/runner/work/aegion/aegion/apps/dashboard/src/main.tsx`
- `/home/runner/work/aegion/aegion/apps/dashboard/src/App.tsx`
- `/home/runner/work/aegion/aegion/apps/dashboard/src/api.ts`

### Master dashboard entry points

- `/home/runner/work/aegion/aegion/apps/master-dashboard/src/main.tsx`
- `/home/runner/work/aegion/aegion/apps/master-dashboard/src/App.tsx`

### Sovereign admin (Next.js) entry points

- `/home/runner/work/aegion/aegion/packages/sovereign-admin/package.json`
- `/home/runner/work/aegion/aegion/packages/sovereign-admin/src/app/layout.tsx`
- `/home/runner/work/aegion/aegion/packages/sovereign-admin/src/app/page.tsx`
- `/home/runner/work/aegion/aegion/packages/sovereign-admin/src/app/dashboard/page.tsx`

### Package module entry points

- `/home/runner/work/aegion/aegion/packages/core/src/index.ts`
- `/home/runner/work/aegion/aegion/packages/sentinels/src/index.ts`
- `/home/runner/work/aegion/aegion/packages/sdk/src/index.ts`
- `/home/runner/work/aegion/aegion/packages/mirror/src/index.ts`
- `/home/runner/work/aegion/aegion/packages/updater/index.ts`

---

## Recommended Reading Path

1. `/home/runner/work/aegion/aegion/README.md`
2. `/home/runner/work/aegion/aegion/package.json`
3. `/home/runner/work/aegion/aegion/apps/api/src/index.ts`
4. `/home/runner/work/aegion/aegion/apps/api/src/server.ts`
5. `/home/runner/work/aegion/aegion/apps/api/src/routes/health.ts`
6. `/home/runner/work/aegion/aegion/apps/dashboard/src/App.tsx`
7. `/home/runner/work/aegion/aegion/packages/core/src/index.ts`
8. `/home/runner/work/aegion/aegion/docs/API-SPEC.md`
9. `/home/runner/work/aegion/aegion/docs/STATE-MACHINE.md`
10. `/home/runner/work/aegion/aegion/docs/DB-SCHEMA.md`
