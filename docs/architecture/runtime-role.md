# Runtime database role

`prisma/migrations/20261101234500_voyara_runtime_role/migration.sql` is applied. It creates `voyara_runtime` as `NOLOGIN` and `NOINHERIT`. It stores no password.

An operator later provisioned a login for `voyara_runtime` outside this repository. The role authenticated through the Supabase transaction pooler on port 6543 as `voyara_runtime` on database `postgres`. Gate B2 passed on that separate connection: permitted reads, denied writes, one ledger reservation, and eight concurrent reservations. The owner connection then deleted the four temporary ledger rows. The ledger was empty afterward.

Production `DATABASE_URL` and `DIRECT_URL` are unchanged. The application still connects as the table owner. Production cutover is not approved. `VOYARA_INTERPRETER_PROVIDER` stays unset. The runtime password stays out of `.env` and out of git.

## What the role can do

`voyara_runtime` receives `USAGE` on schema `public`, `SELECT` on `country`, `region`, `stay_base`, `place`, `curated_tip`, `sample_itinerary`, and `sample_itinerary_item`, and `SELECT`, `INSERT`, and `UPDATE` on `interpreter_usage_bucket`.

It is not granted `DELETE`, `TRUNCATE`, or access to any other table. It is not added to `postgres`, `pg_read_all_data`, `anon`, `authenticated`, `service_role`, or `authenticator`. No default privileges are changed.

The `SELECT` policies use `USING (true)`. They do not filter `approval`. This server role can read draft rows in those seven tables. `loadApprovedEditorialCatalog` still applies the approval filter in its query. The policies name only `voyara_runtime`, so `anon`, `authenticated`, and `service_role` do not gain a policy.

Row-level security stays unforced, so the table owner keeps bypassing it. `npm run db:seed` uses `DIRECT_URL`, the owner session pooler, and refuses a `voyara_runtime` username.

## Login provisioning, not in this migration

The migration does not store a password and does not grant `LOGIN`. Login was provisioned later, outside this repository, from the migration owner. The password is not in this repository. The transaction pooler accepted the username `voyara_runtime` plus the existing tenant suffix on port 6543.

That proof does not switch the application. Leave the password out of `.env` until a separate production cutover is approved, and do not commit it.

To remove the login again without dropping grants:

```sql
ALTER ROLE voyara_runtime NOLOGIN;
```

## API-role grants this migration leaves in place

`anon`, `authenticated`, and `service_role` currently have `TRUNCATE`, `REFERENCES`, and `TRIGGER` on the catalog tables. They cannot log in directly. `authenticator` can assume them. Row-level security does not restrict `TRUNCATE`. The Data API does not expose `TRUNCATE`.

This migration does not revoke those grants. Revoking them is a separate change because it touches every catalog table and is not required for the runtime role. `interpreter_usage_bucket` already has no grants for those roles.

## Gate B2 verification

These checks passed on a separate `voyara_runtime` connection through the transaction pooler on port 6543. They did not use production `DATABASE_URL`. `VOYARA_INTERPRETER_PROVIDER` stayed unset. No model was called. Cleanup used the owner connection.

1. Approved catalog rows were readable, including `country` where `approval` is `approved`. A known draft country was also visible with no approval filter. Draft visibility is the policy. `loadApprovedEditorialCatalog` still applies the approval filter in its query.
2. `SELECT` from protected tables was denied, including `historical_amount` and `stay_property`.
3. `INSERT`, `UPDATE`, and `DELETE` on `country` were denied. `DELETE` on `interpreter_usage_bucket` was denied. `TRUNCATE` on that table is not granted and was not executed.
4. `reserveInterpreterRequest` for caller id `e43-single-verify` at `2099-04-01T12:00:00.000Z`, caller limit 8, window 60 seconds, and daily limit 200 returned `allowed`. The rows were `global:2099-04-01` and `caller:e43-single-verify:2099-04-01T12:00:00.000Z`.
5. Eight concurrent calls for caller id `e43-concurrency-verify` at `2099-04-02T15:30:00.000Z`, caller limit 20, and daily limit 5 returned 5 `allowed` and 3 `limited`. All eight calls completed. The stored count on `global:2099-04-02` was 5. None returned `unavailable`.
6. The owner connection deleted only these four keys:

```sql
DELETE FROM interpreter_usage_bucket
WHERE bucket_key IN (
    'global:2099-04-01',
    'caller:e43-single-verify:2099-04-01T12:00:00.000Z',
    'global:2099-04-02',
    'caller:e43-concurrency-verify:2099-04-02T15:30:00.000Z'
);
```

The ledger was empty after that delete. `DATABASE_URL` and `DIRECT_URL` stayed on the owner. Production cutover is not approved.
