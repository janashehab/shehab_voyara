-- Least-privilege runtime role. This migration does not create a login.
-- voyara_runtime cannot connect until an operator, outside this repository,
-- provisions a credential for it. The procedure is in docs/architecture/runtime-role.md.
-- Do not grant this role to authenticator, anon, authenticated, or service_role.
--
-- Catalog SELECT policies use USING (true). They do not filter approval.
-- Draft rows in these seven tables are readable by this server role.
-- The application query still keeps unapproved rows out of public responses.
--
-- This migration does not revoke anon, authenticated, or service_role
-- TRUNCATE, REFERENCES, or TRIGGER grants on existing catalog tables.
-- Those grants are a separate cleanup. Row-level security does not apply
-- to TRUNCATE, and the Data API does not expose that command.

CREATE ROLE voyara_runtime NOLOGIN NOINHERIT;

GRANT USAGE ON SCHEMA public TO voyara_runtime;

GRANT SELECT ON TABLE
    "country",
    "region",
    "stay_base",
    "place",
    "curated_tip",
    "sample_itinerary",
    "sample_itinerary_item"
TO voyara_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE "interpreter_usage_bucket" TO voyara_runtime;

ALTER TABLE "country" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "region" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stay_base" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "place" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "curated_tip" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sample_itinerary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sample_itinerary_item" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "voyara_runtime_select" ON "country"
    FOR SELECT TO voyara_runtime USING (true);
CREATE POLICY "voyara_runtime_select" ON "region"
    FOR SELECT TO voyara_runtime USING (true);
CREATE POLICY "voyara_runtime_select" ON "stay_base"
    FOR SELECT TO voyara_runtime USING (true);
CREATE POLICY "voyara_runtime_select" ON "place"
    FOR SELECT TO voyara_runtime USING (true);
CREATE POLICY "voyara_runtime_select" ON "curated_tip"
    FOR SELECT TO voyara_runtime USING (true);
CREATE POLICY "voyara_runtime_select" ON "sample_itinerary"
    FOR SELECT TO voyara_runtime USING (true);
CREATE POLICY "voyara_runtime_select" ON "sample_itinerary_item"
    FOR SELECT TO voyara_runtime USING (true);

CREATE POLICY "voyara_runtime_select" ON "interpreter_usage_bucket"
    FOR SELECT TO voyara_runtime USING (true);
CREATE POLICY "voyara_runtime_insert" ON "interpreter_usage_bucket"
    FOR INSERT TO voyara_runtime WITH CHECK (true);
CREATE POLICY "voyara_runtime_update" ON "interpreter_usage_bucket"
    FOR UPDATE TO voyara_runtime USING (true) WITH CHECK (true);
