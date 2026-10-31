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

A failed attempt still sets `lastCheckedAt` and appends history. It does not set `lastVerifiedAt`, does not move `expiresAt` forward, and does not mark the payload verified.

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

The sync service will live at `src/server/sync/` when the sync step is requested. Do not add jobs, cron, queues, or provider clients before that.

```text
src/server/sync/
  types.ts          SourceRef, Freshness, SyncTarget, ProviderPayload, SyncResult
  policy.ts         approved-target check, permitted-field filter, editorial strip
  registry.ts       map of provider key to adapter; starts empty
  runner.ts         background refresh orchestration
  revalidate.ts     synchronous price check used by booking
  providers/
    flights/
    accommodation/
    weather/
    activities/
```

Adapter contract:

```ts
interface CatalogSyncProvider {
  key: string
  domain: "flights" | "accommodation" | "weather" | "activities" | "other"
  fetchUpdate(target: ApprovedRecordRef): Promise<ProviderPayload>
}
```

The adapter returns data. The runner and the policy module write the database.

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

Providers still to be designed as separate adapters: flights, accommodation, weather, activities, and further domains under `other`. Each adapter declares its domain and its permitted fields. The policy module refuses a field the adapter is not allowed to write.

### New entities

An adapter must not insert a `Destination`, `Place`, `Hotel`, or `Activity`.

A later admin inbox may store an unpublished `CatalogSuggestion` with `proposedType`, a source, and status `pending`, `approved`, or `rejected`. A suggestion is not a catalog row. Discovery and the planner do not read it. Approval is a separate admin action that creates the catalog entity. Rejection writes nothing into the approved catalog.

That inbox is not part of the current foundation.

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

## Database step

When the schema is added, model editorial columns on the catalog tables and dynamic facts on separate tables with the contract above. Seed approved editorial examples only. Leave dynamic prices unverified until a real revalidation succeeds.

Do not seed `freshness: fresh` or a `lastVerifiedAt` for a price that no provider has confirmed.
