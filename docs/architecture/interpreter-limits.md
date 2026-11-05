# Interpreter request limits

These controls apply only to a real interpreter provider call. Questionnaire buttons, locks, museum choices, and the scripted development interpreter do not reserve a row and do not call the provider.

The provider stays off unless `VOYARA_INTERPRETER_PROVIDER` is exactly `enabled` and `AI_API_KEY` is present. This document does not turn that provider on.

## What is counted

The ledger counts interpretation requests. It does not count tokens, and it does not cap money. A request is reserved before the provider is called. The reservation remains if that call then times out or returns an error.

Defaults, used when the matching variable is unset:

| Variable | Default | Accepted when set |
| --- | --- | --- |
| `VOYARA_INTERPRETER_CALLER_LIMIT` | 8 requests | integer 1–1000 |
| `VOYARA_INTERPRETER_CALLER_WINDOW_SECONDS` | 60 seconds | integer 1–86400 |
| `VOYARA_INTERPRETER_DAILY_LIMIT` | 200 requests per UTC day | integer 1–100000 |

A set value outside that range, or any non-integer, makes the provider call unavailable. The call is not sent.

Both buckets are updated in one database transaction. That transaction takes a per-day advisory lock first, then increments the daily bucket and the caller bucket. If the caller bucket is already full, the daily increment is reversed before commit. The daily bucket is `global:YYYY-MM-DD`. The caller bucket is a hash plus the start of that caller’s window. The increment itself is conditional on the stored count still being under the limit, so two overlapping requests cannot both pass a full bucket.

## Caller identity

This repository does not name the proxy in front of the website. `X-Forwarded-For` and `X-Real-IP` are not trusted for the AI ledger.

`VOYARA_TRUSTED_PROXY_HOPS` must be set to the number of proxies that append an address, from 1 to 5, before per-caller limits mean one visitor. With one trusted proxy, `1` selects the rightmost address. Addresses to the left are ignored. If the header has fewer addresses than the hop count, or the selected value is not an IP, the caller is `unverified` and shares that bucket.

When the hop count is unset, empty, or invalid, every AI caller shares one `direct` bucket. The header is not read. A wrong hop count therefore groups visitors together. It does not accept the leftmost client-supplied address.

`VOYARA_INTERPRETER_CALLER_PEPPER` is a server-only string mixed into the stored hash. When `VOYARA_TRUSTED_PROXY_HOPS` is 1–5, the trimmed pepper must be at least 32 characters. A missing or shorter pepper makes the provider unavailable before a ledger reservation or a provider call. When the hop count is unset, empty, or invalid, callers share the `direct` bucket and the pepper is not required. Set a long random value before public traffic so the stored caller id is not an enumerable hash of an IPv4 address. The raw address is not stored.

The node test runner does not import `resolveServerInterpreter` because `server-only` rejects that import. Direct coverage of that wrapper remains outstanding. The pepper tests cover `prepareInterpreter`, which is the function that wrapper returns.

The in-memory concierge screen still uses the first `X-Forwarded-For` hop for questionnaire actions. That screen is process-local, resets on restart, and is not the paid-call budget.

## Endpoint

A provider call is sent only to `https://api.openai.com/v1/chat/completions`. Leave `AI_INTERPRETER_URL` unset to use that URL. Any other host, path, port, query, or embedded username makes the provider unavailable. The API key is not sent. Tests pass a fake `fetch` and do not use that host.

## Ledger table

The ledger migration `prisma/migrations/20261101230000_interpreter_usage_bucket/migration.sql` is applied. It creates `interpreter_usage_bucket` with a nonnegative check on `request_count`, enables row-level security, and revokes access from `PUBLIC`, `anon`, `authenticated`, and `service_role` when those roles exist. It adds no permissive policy. A revoke does not remove privileges inherited through another role.

The Prisma model `InterpreterUsageBucket` matches those columns so a later migrate does not drop the table. Reservation still uses the raw SQL in `src/server/ai/interpreter-budget.ts`.

A database error during reservation fails closed and does not reach the model. The client message does not include the database error, the connection string, or the API key. The application still connects as the table owner through `DATABASE_URL`. `DIRECT_URL` is unchanged. The least-privilege role in `docs/architecture/runtime-role.md` is applied, and Gate B2 proved it on a separate transaction-pooler connection. Production cutover is not approved. The provider stays off.

The application does not delete old ledger rows. They are keyed by day and window, so a later window uses a new row. Gate B2 deleted only its four exact test keys through the owner connection and left the ledger empty.

## Deployment still required

Gate B2 is complete. These items remain before the provider accepts traveler traffic. Production cutover is a separate decision and is not approved.

- Leave `DATABASE_URL` and `DIRECT_URL` on the owner until that cutover is approved.
- Set `VOYARA_TRUSTED_PROXY_HOPS` to the actual number of appending proxies. The deployment is not defined in this repository.
- Set `VOYARA_INTERPRETER_CALLER_PEPPER` before public traffic.
- Set `AI_API_KEY` only in the server environment. Do not put it in a `NEXT_PUBLIC` variable.
- Choose request limits knowingly. They are not a monetary cap.
- Keep `VOYARA_INTERPRETER_PROVIDER` unset until those items are done and cutover is separately approved. The `/plan` page still describes the scripted development preview, which is what runs while the provider is off.
