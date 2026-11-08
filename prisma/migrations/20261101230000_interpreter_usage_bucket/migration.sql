-- Shared interpreter request ledger. Counts are requests, not money.
-- This file is the reviewed migration. Applying it is a separate step.
-- anon, authenticated, and service_role exist on Supabase. A plain shadow
-- database does not, so those revokes run only when the role is present.
-- REVOKE does not remove privileges inherited from another role.

CREATE TABLE "interpreter_usage_bucket" (
    "bucket_key" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "request_count" INTEGER NOT NULL,

    CONSTRAINT "interpreter_usage_bucket_pkey" PRIMARY KEY ("bucket_key"),
    CONSTRAINT "interpreter_usage_bucket_count_nonnegative" CHECK ("request_count" >= 0)
);

ALTER TABLE "interpreter_usage_bucket" ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE "interpreter_usage_bucket" FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE "interpreter_usage_bucket" FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE "interpreter_usage_bucket" FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        REVOKE ALL ON TABLE "interpreter_usage_bucket" FROM service_role;
    END IF;
END
$$;
