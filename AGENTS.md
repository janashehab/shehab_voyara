<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Voyara

Voyara is an AI travel planning and booking platform. Phase 1 is this Next.js website. Phase 2 is a mobile travel companion. Both clients will share one PostgreSQL catalog.

Read `docs/architecture/data-policy.md` before changing the catalog, the planner, booking, or any provider integration. That document is the source of truth for catalog and provider data.

## Current scope

Step 1 is the application foundation: Next.js App Router, TypeScript, Tailwind CSS, and ESLint. The site does not yet have a database, auth, planner, booking flow, admin dashboard, sync jobs, or external APIs.

Do not add those until the corresponding step is requested. Do not connect flight, hotel, weather, activity, or search APIs while implementing an earlier step.

## Stack

- Next.js 16.4, React 19, TypeScript, Tailwind CSS 4, ESLint
- PostgreSQL and Prisma 7, added in the database step. Pin Prisma to the 7.10 stable line. The `prisma` `latest` tag is an 8.x release candidate.
- Better Auth for travelers and admins, added with the auth step
- Zod for catalog and planner payloads
- AI provider stays behind `src/server/ai` and is chosen before the planner step
- One Next.js app until the mobile client exists. Shared use-cases live in `src/server/services` so a later HTTP API can call them. Server Actions stay web-only.

`cacheComponents` and `partialPrefetching` are enabled in `next.config.ts`. Follow the matching guides under `node_modules/next/dist/docs/` when adding data fetching or navigation.

## Repository layout

```text
src/app/                  routes, layouts, loading and error UI
src/features/             feature UI, schemas, queries, server actions
src/server/db.ts          Prisma client
src/server/auth.ts
src/server/ai/            planner, grounded on approved catalog rows
src/server/services/      use-cases with no UI
src/server/sync/          provider sync architecture (not implemented)
src/components/           shared layout and primitives
src/lib/                  shared helpers
prisma/                   schema, migrations, curated seed
docs/architecture/        architecture and data policy
```

Route files stay thin. Feature code calls `src/server/services`. Sync and planner code call the data policy; they do not write catalog rows themselves.

Target feature folders: `destinations`, `trips`, `itinerary`, `packages`, `bookings`, `admin`.

## Catalog rules

Voyara uses a closed, team-curated catalog. The planner may recommend only destinations, places, hotels, and activities that already exist as approved records.

- The planner has no open-web search and no external destination discovery.
- Model output cannot create a destination, place, hotel, or activity.
- A provider update cannot create an approved catalog entity. A new entity enters the catalog through administrative review.
- Curated copy and vibe tags stay editorial. Provider payloads write only permitted dynamic fields on an existing approved record.
- Flight and hotel prices are verified only by a successful revalidation immediately before booking. A failed refresh is an unsuccessful verification. Keep the previous price out of any confirmed-price state.

Full field ownership, freshness, history, and the sync module boundaries are in `docs/architecture/data-policy.md`.

## Implementation sequence

1. Foundation. Done.
2. Prisma schema, migration, and a curated seed. Include dynamic-data and update-history tables. Seed editorial records only. Do not seed a price as verified.
3. App shell.
4. Public discovery of approved catalog records.
5. Auth and the admin role.
6. Trip creation and a planner that can recommend only approved destinations, places, hotels, and activities.
7. Itinerary editor.
8. Progressive package builder.
9. Booking requests. Revalidate flight and hotel prices before accepting a price as verified.
10. Admin catalog editing and the booking queue. New catalog entities are created here.
11. Access checks, validation, and loading and error states.

Sync jobs and live provider adapters are a later step. Build the module boundaries from the data policy when that step is requested. Until then, leave `src/server/sync` unimplemented and add no provider credentials.
