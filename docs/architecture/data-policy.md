# Catalog and provider data policy

Voyara recommends travel from a closed catalog curated by the team. Provider APIs may refresh operational facts on records the team has already approved. They do not expand the catalog.

This policy is binding for the database, the AI planner, booking, admin tools, and any future sync adapter. Step 1 does not implement the schema, jobs, or provider clients.

## Closed catalog

The planner and public discovery may recommend only these approved entities:

| Entity | Meaning |
|---|---|
| `Destination` | A team-approved place the traveler can plan around |
| `Place` | A point of interest inside a destination |
| `Hotel` | A specific accommodation property |
| `Activity` | A bookable or schedulable experience tied to a destination |

Each entity has an approval state: `draft`, `in_review`, `approved`, or `archived`. Discovery and the planner read `approved` rows only. Drafts, suggestions, and archived rows stay out of prompts and out of traveler-facing lists.

Flights and weather are not catalog entities. A flight offer is dynamic data attached to a package component. Weather is dynamic data attached to an approved destination.

### Planner constraints

The itinerary planner receives a retrieval set of approved records and returns references to those ids.

- Ground every recommended destination, place, hotel, and activity in an approved row.
- When the catalog cannot satisfy a constraint, say so and offer approved alternatives from that retrieval set.
- Reject model output that names an entity id the retrieval set does not contain.
- Give the model no tool for web search, browsing, or catalog writes.
- Persist the approved ids used for each generation.

Do not add open-web AI search, external destination discovery, or a path that inserts catalog rows from model output.

## Editorial content and dynamic data

Store curated content and provider data separately. A provider write updates a dynamic row. It leaves the catalog entity's editorial columns unchanged.

Editorial fields, owned by the team:

- name and slug
- editorial description and summary
- vibe tags
- curated highlights
- team practical notes
- approval state
- team-selected media

Permitted dynamic fields, owned by sync and revalidation:

| Domain | Attached to | Permitted fields |
|---|---|---|
| Weather | Approved `Destination` | condition, temperature, alerts, observation time |
| Accommodation | Approved `Hotel` | amount, currency, availability, rate name, cancellation summary, room count, supplier property id |
| Activities | Approved `Activity` | amount, currency, schedule, availability, supplier operational instructions |
| Place operations | Approved `Place` | opening hours, temporary closure |
| Flights | Package component | amount, currency, segments, fare basis, seats, provider offer id, offer expiry |

A hotel or activity must already be approved before its price or availability can be stored. Mapping a supplier property id onto a hotel is an admin action. A provider response that does not match an approved record produces no catalog insert.

If a payload includes an editorial field, drop that field and keep the rest of the permitted update. Do not overwrite a description or a vibe tag with supplier copy, ratings text, or marketing labels.

## Dynamic record contract

Every dynamic row records where the fact came from, when it was checked, whether it is still fresh, and what changed.

Required fields:

| Field | Rule |
|---|---|
| `subjectType` and `subjectId` | The approved catalog row, or the package component for a flight offer |
| `domain` | `flights`, `accommodation`, `weather`, `activities`, or `other` |
| `source.providerKey` | Stable adapter id. Adapters are registered later. |
| `source.externalId` | The provider's id for this fact |
| `source.retrievedBy` | `sync` or `revalidation` |
| `lastCheckedAt` | Time of the latest attempt, including failures |
| `lastVerifiedAt` | Time of the latest successful check. Remains unchanged when the attempt fails. Null until the first success. |
| `expiresAt` | Hard expiry from the successful check. Remains unchanged when the attempt fails. |
| `freshness` | `fresh`, `stale`, `expired`, or `refresh_failed` |
| `payload` | Permitted dynamic fields only |

Freshness:

- `fresh`: the latest attempt succeeded, `lastVerifiedAt` is set, and the current time is before both the stale point and `expiresAt`.
- `stale`: the latest attempt succeeded and the current time is at or after the stale point and before `expiresAt`. Stale data may be shown as unverified. It does not confirm a booking price.
- `expired`: there has been no successful check, or the current time is at or after `expiresAt`, and the latest attempt itself did not fail.
- `refresh_failed`: the latest attempt failed. This state replaces `fresh`, `stale`, and `expired` as soon as the failure is recorded.

A failed attempt still sets `lastCheckedAt` and appends history. It does not set `lastVerifiedAt`, does not move `expiresAt` forward, and does not mark the payload verified. `lastVerifiedAt` and `expiresAt` stay independent: the first is the previous successful verification, and the second is the offer expiry. A failure records `refresh_failed` without moving either timestamp and without replacing the previous payload.

The previous payload may remain stored so an operator can see the last received values. Display and booking logic treat that payload as unverified while freshness is `refresh_failed`, `stale`, or `expired`.

## Update history

Each attempt appends a `DynamicUpdate` row. History is append-only.

| Field | Rule |
|---|---|
| `dynamicRecordId` | The dynamic row this attempt targeted |
| `attemptedAt` | Attempt time |
| `providerKey` and `externalId` | Source of the attempt |
| `outcome` | `succeeded` or `failed` |
| `errorCode` | Present on failure. Store no credentials or raw secrets. |
| `changedFields` | Permitted field names written on success. Empty on failure. |
| `previousPayload` | Payload before the attempt |
| `nextPayload` | Payload after a success. Null on failure. |

A failure leaves the dynamic payload unchanged and records `nextPayload` as null. History never contains editorial description or vibe-tag writes.

## Synchronization architecture

The pure policy and adapter interfaces live at `src/server/sync/`. The registry starts empty. This step does not add jobs, cron, queues, HTTP clients, or provider credentials.

```text
src/server/sync/
  types.ts          adapter interfaces, links, offers, facts, suggestions, audits
  policy.ts         approved-target check, permitted-field filter, editorial strip
  freshness.ts      fresh, stale, expired, refresh_failed, and bookable checks
  registry.ts       in-memory adapter map; starts empty; no network
```

A later scheduler and the HTTP adapters are still deferred. Weather remains a later domain. The interfaces covered now are flight shopping, hotel shopping, flight status, mapping, and activities.

Adapter contract:

```ts
interface CatalogSyncProvider {
  key: string
  domain: "flights" | "accommodation" | "weather" | "activities" | "other"
  fetchUpdate(target: ApprovedRecordRef): Promise<ProviderPayload>
}
```

The adapter returns data. The policy module decides what may be stored. A future runner writes the database. No adapter in this step calls the network.

Write path for a successful fetch:

1. Load the target by id.
2. Continue only when the target exists and is `approved`. A flight target is an existing package component, not a new catalog entity.
3. Keep only permitted fields for that domain. Discard editorial fields.
4. Update the dynamic row keyed by subject, domain, `providerKey`, and `externalId`.
5. Set `lastCheckedAt`, `lastVerifiedAt`, `expiresAt`, and `freshness` from this success.
6. Append a `DynamicUpdate` with `outcome: succeeded`.

Write path for a failed fetch, timeout, empty registry, or missing credentials:

1. Append a `DynamicUpdate` with `outcome: failed` and `nextPayload: null`.
2. Set `lastCheckedAt` and `freshness: refresh_failed`.
3. Leave `lastVerifiedAt`, `expiresAt`, and the payload as they were.
4. Return an unsuccessful result to the caller. Do not convert that result into a verified price.

HTTP adapters are still to be designed for flights, accommodation, weather, activities, and further domains under `other`. Each adapter declares its domain and its permitted fields. The policy module refuses a field the adapter is not allowed to write. Weather has no interface in this step.

### New entities

An adapter must not insert a `Destination`, `Place`, `Hotel`, or `Activity`.

A later admin inbox may store an unpublished `CatalogSuggestion` with `proposedType`, a source, and status `pending`, `approved`, or `rejected`. A suggestion is not a catalog row. Discovery and the planner do not read it. Approval is a separate admin action that creates the catalog entity. Rejection writes nothing into the approved catalog.

The policy records that suggestion in memory with status `pending`. It does not create or approve a catalog row. The admin inbox UI is still a later step. Approving a suggestion, which creates the catalog entity, stays a separate admin action.

## Persistence and scheduled synchronization

These requirements are not implemented yet. They are the contract for the database and scheduler steps.

Persist editorial columns on the catalog tables. Persist supplier links, dated offers, supplier facts, dynamic updates, pending suggestions, and audit events in their own tables. A dated offer is not an editorial field, and a suggestion is not a catalog entity.

The scheduler, when it is added, refreshes only an entity that is already `approved` and already has an admin-created supplier link. It runs on the server. It reads provider credentials from server environment variables and does not put those values in payloads, audits, logs, or client responses. A failed run uses the failure path above: it does not move `lastVerifiedAt` or `expiresAt`. It does not approve a suggestion or an imported draft, including the Thailand inventory. Repeated payloads for the same supplier offer id update one offer row.

Until that scheduler and database exist, callers use the in-memory policy directly. An empty adapter registry is a failed refresh, not a verified price.

Two sync integrations are specified and not implemented:

- A failed refresh must name the supplier request or the individual offer that failed, and update only that row. The current failure path still marks every offer and fact on the supplier link as `refresh_failed`.
- Sync must load approval from trusted server-side catalog storage. `SyncTarget.approval` supplied by the caller is not the source of truth.

## Price revalidation before booking

Background freshness is not booking verification. Flight prices and hotel prices are revalidated synchronously before a booking request treats them as verified.

A price is verified for that booking attempt only when this revalidation returns success, the recorded freshness is `fresh`, and `lastVerifiedAt` was set by this attempt.

These outcomes are unsuccessful verification:

- provider error, timeout, or malformed payload
- no adapter registered for the price
- skipped, cached, or background-only refresh
- a previous `lastVerifiedAt` while the latest attempt failed
- `stale`, `expired`, or `refresh_failed`

On an unsuccessful revalidation, persist `refresh_failed` using the failure path above. The booking request must not store the price as confirmed and must not advance as if verification succeeded.

The same policy module serves background sync and pre-booking revalidation, so both paths share the permitted-field list and the failure rules.

## Phase 1 pricing

Historical prices imported from the Thailand inventory are internal reference data. They are not customer quotes and they are not live fares.

A later step may store a permitted web-observed price as a `PriceObservation`. That record stays separate from a verified supplier offer. The site may show it as an indicative estimate only when the observation is fresh enough and the dates, occupancy, and other conditions match what the customer asked for. This step does not scrape the web and does not add a `PriceObservation` table.

Final quotations and bookings are handled manually by the Voyara team. A displayed estimate does not confirm a price.

## Catalog approval

Editorial approval is a team decision. It is not supplier freshness, not a live offer, and not a verified guest score. The workflow lives in `src/server/services/catalog-approval`. It is server code. It has no page, no route, and no server action. No approval endpoint is exposed until authentication and authorization exist. Until that auth step, the operation accepts a server-side actor argument and rejects a public caller, an unauthenticated actor, and any supplier payload.

The workflow changes one record at a time: a country, a region, a stay base, an accommodation property, or a flight route template. It does not approve the imported catalog in bulk. Approving one record does not approve its parent or its children. Rate variants, historical amounts, areas, and editorial recommendation notes stay at the approval state they already have.

Allowed transitions:

| From | To |
|---|---|
| `draft` | `in_review`, `archived` |
| `in_review` | `draft`, `approved`, `archived` |
| `approved` | `in_review`, `archived` |
| `archived` | `draft` |

A country, region, or stay base uses the same transition graph. A region can become `approved` only when its country is already `approved`. A stay base can become `approved` only when its country and region are already `approved`. These records do not need an identity attestation. They are team-defined geography, and each one is still an explicit admin action.

Moving a property or flight template to `approved` also requires an identity attestation from a trusted admin. The attestation stores a fingerprint of the identity-critical fields. For a property those fields are the name, source ids, and geographic assignment. For a flight template they are the source id and the origin and destination of each leg. Carriers are not part of that fingerprint. If those fields change through the database, the same transaction invalidates the active attestation and writes an audit. Public retrieval then fails until a new attestation. The in-memory policy still detects a stale fingerprint on the next trusted approval call when that call is used without the database. The attestation does not itself change approval and it does not create a live offer.

A property needs a name, at least one source id, provenance for each source id, and no other property using those source ids. It also needs a country, a region in that country, and a stay base in that region, and those three records must already be `approved`. An area is required only when the property already names one, and that area must belong to the stay base. Area records are not part of this public hierarchy. A live price is not required. Approving the property does not approve its rate variants, and it does not turn a historical amount into a dated offer.

Import findings stay on the catalog. A resolution is a separate ledger row. It does not delete the finding.

| Class | Examples | Approval |
|---|---|---|
| Blocking identity | Listing still needs verification, grouped rows that disagree on location | Must be resolved. A quality override cannot skip it. |
| Blocking geography | Krabi stay with no Ao Nang or Koh Lanta base | Must be resolved, and the stay base must exist. A quality override cannot skip it. |
| Serious quality | `qualityReview` on the property | Blocks approval until a documented quality override. |
| Missing detail | Room size, breakfast, historical price, star rating, an unresolved airline, a Krabi flight that does not choose a stay base, a neighborhood mentioned only in a name | Does not block approval. |

Catalog-wide notes with no source id, including similar property names, do not block one property.

A flight route template is not a dated flight offer. It needs provenance, and each leg needs an origin and a destination that differ. Missing carriers and several possible carriers stay unresolved metadata on the template. A city or airport is not an accommodation stay base, so a flight may end at Krabi Airport without selecting Ao Nang or Koh Lanta. Approving the template does not approve its historical amount and does not mark a fare live. Public retrieval labels it `route_template` with confirmed flight and live fare both false.

Each transition, rejection, attestation, invalidation, finding resolution, and quality override appends an audit event with the actor, timestamp, subject, and reason. Supplier secrets are not copied into the audit.

Public retrieval returns an approved property only while its country, region, and stay base are also `approved`. Archiving the stay base removes the property from retrieval and does not change the property's own approval. Draft, in-review, and archived records stay out. Retrieval does not read freshness or price. An approved flight template is returned as a route template, not as a bookable fare.

### Approval storage

The Prisma migration defines these tables. It has not been applied to the Supabase project.

- Keep `approval` on the catalog row for the country, region, stay base, property, or flight template.
- A newly imported Thailand row starts as `draft`. A finding can block approval. It does not move the row to `in_review`.
- Append each attempt to an `approval_audit` table: actor id, timestamp, subject type, subject id, previous state, next state, reason, and error code. The table is append-only. Invalidations, finding resolutions, and quality overrides are audited there too.
- Store identity attestations in their own table, with the fingerprint of the identity-critical fields. A database update to a name, source id, route, or geographic assignment invalidates the row in that same transaction. It does not delete the history.
- Store finding resolutions and quality overrides in their own tables. Do not delete the original import finding.
- Keep a future `PriceObservation` separate from verified supplier offers and from historical reference amounts. The migration does not create `PriceObservation`.
- A historical amount is constrained to an internal reference: presentation `historical_reference`, `live_quote` false, freshness `unverified`, and no verification timestamp.
- Do not store approval inside a supplier payload, a dated offer, or a historical amount.
- The future auth module is the only server code that may mark an actor authenticated. The database write runs on the server after that check.
- Import idempotency is the source checksums plus `CATALOG_NORMALIZER_VERSION`. A repeated run does not duplicate rows, clear an approval, or replace an admin-locked identity field.

## Database step

`prisma/schema.prisma` models the editorial catalog, historical amounts, provenance, and the approval ledger. Paris editorial examples are seeded approved. Thailand rows are seeded draft. Dynamic supplier prices stay unverified until a real revalidation succeeds, and this step does not store them.

The public homepage and destination page read approved editorial rows from PostgreSQL through `loadApprovedEditorialCatalog`. A stay base is included only when that stay base, its country, and its region are approved. Places, tips, and sample itineraries have to belong to that set. The read leaves `dynamicFacts` empty, so historical amounts are not quotes. Stay properties and flight templates are not part of this read. Draft Thailand rows remain in the database and stay off these pages.

The destination proxy checks slug shape only. A public slug is lowercase letters and numbers, with single hyphens between words, and it is at most 64 characters. Any other shape is rewritten to the catalog-miss path. The proxy does not open the database and does not read the prototype fixture. A well-formed slug is not an approval.

The destination page looks the slug up in the approved public catalog. An unknown, draft, archived, or otherwise unapproved destination calls `notFound()`. A failed catalog read stays an error. The page says the catalog could not be opened. It does not substitute the Paris fixture and it does not publish a draft row.

`generateStaticParams` returns the Paris slug so Cache Components can prerender one destination route. That value is a build seed, not a publication allowlist. The approved catalog decides whether a well-formed slug is published. A slug outside the seed can still render on request.

For this Paris-only preview, a well-formed unknown, draft, or archived destination is an unresolved public-launch concern. Next.js postpones the response, sends HTTP 200, and then renders the not-found page. `notFound()` inserts `<meta name="robots" content="noindex">` into that body. The meta tag is the indexing signal. The status line stays 200, so a status check, an uptime probe, or a crawler that ignores robots metadata will treat the URL as a successful page. Malformed slugs stay a real HTTP 404 from the proxy and should be monitored separately. This route sets no cache lifetime. A completed miss might remain cached until a later request replaces it. That stickiness is a risk: a destination approved after a cached miss could keep showing the not-found page. It is not a confirmed persistent-cache defect.

Closing the route with build-time slug matching was rejected. That approach would require a new build before a newly approved destination could be published. The catalog remains the authority.

Do not seed `freshness: fresh` or a `lastVerifiedAt` for a price that no provider has confirmed.
