-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "approval_state" AS ENUM ('draft', 'in_review', 'approved', 'archived');

-- CreateEnum
CREATE TYPE "place_kind" AS ENUM ('poi', 'food', 'neighborhood', 'hotel', 'activity', 'transport');

-- CreateEnum
CREATE TYPE "item_role" AS ENUM ('core', 'alternative', 'editorial_addition');

-- CreateEnum
CREATE TYPE "breakfast_inclusion" AS ENUM ('included', 'not_included', 'unknown');

-- CreateEnum
CREATE TYPE "journey_kind" AS ENUM ('return', 'multi_city', 'one_way');

-- CreateEnum
CREATE TYPE "flight_option_label" AS ENUM ('cheapest', 'better_timing', 'alternative');

-- CreateEnum
CREATE TYPE "historical_presentation" AS ENUM ('historical_reference');

-- CreateEnum
CREATE TYPE "historical_freshness" AS ENUM ('unverified');

-- CreateEnum
CREATE TYPE "historical_retrieval" AS ENUM ('manual');

-- CreateEnum
CREATE TYPE "amount_unit" AS ENUM ('per_night', 'itinerary_total');

-- CreateEnum
CREATE TYPE "profile_provenance" AS ENUM ('manual_import', 'supplier');

-- CreateEnum
CREATE TYPE "recommendation_tier" AS ENUM ('cheapest', 'recommended', 'premium', 'luxury');

-- CreateEnum
CREATE TYPE "finding_kind" AS ENUM ('missing', 'ambiguous', 'duplicate');

-- CreateEnum
CREATE TYPE "attestation_status" AS ENUM ('active', 'invalidated');

-- CreateEnum
CREATE TYPE "audit_actor_role" AS ENUM ('admin', 'public', 'supplier');

-- CreateTable
CREATE TABLE "country" (
    "id" TEXT NOT NULL,
    "approval" "approval_state" NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "country_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "region" (
    "id" TEXT NOT NULL,
    "country_id" TEXT NOT NULL,
    "approval" "approval_state" NOT NULL,
    "name" TEXT NOT NULL,
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_base" (
    "id" TEXT NOT NULL,
    "country_id" TEXT NOT NULL,
    "region_id" TEXT NOT NULL,
    "approval" "approval_state" NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "vibe_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "stay_base_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "area" (
    "id" TEXT NOT NULL,
    "stay_base_id" TEXT NOT NULL,
    "approval" "approval_state" NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "area_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "place" (
    "id" TEXT NOT NULL,
    "stay_base_id" TEXT NOT NULL,
    "approval" "approval_state" NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "place_kind" NOT NULL,
    "editorial_summary" TEXT NOT NULL,
    "vibe_tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "area_label" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "approximate_duration_minutes" INTEGER,
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "place_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "curated_tip" (
    "id" TEXT NOT NULL,
    "approval" "approval_state" NOT NULL,
    "body" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "curated_tip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_itinerary" (
    "id" TEXT NOT NULL,
    "approval" "approval_state" NOT NULL,
    "title" TEXT NOT NULL,
    "editorial_note" TEXT,
    "stay_base_ids" TEXT[],
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "sample_itinerary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sample_itinerary_item" (
    "id" TEXT NOT NULL,
    "itinerary_id" TEXT NOT NULL,
    "day_index" INTEGER,
    "sort_order" INTEGER NOT NULL,
    "place_id" TEXT NOT NULL,
    "role" "item_role" NOT NULL,
    "editorial_note" TEXT,

    CONSTRAINT "sample_itinerary_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_property" (
    "id" TEXT NOT NULL,
    "country_id" TEXT NOT NULL,
    "region_id" TEXT NOT NULL,
    "stay_base_id" TEXT,
    "area_id" TEXT,
    "approval" "approval_state" NOT NULL,
    "name" TEXT NOT NULL,
    "source_ids" TEXT[],
    "quality_review" BOOLEAN NOT NULL,
    "editorial_shortlist_bands" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "stay_property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stay_rate" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "approval" "approval_state" NOT NULL,
    "source_id" TEXT NOT NULL,
    "rate_key" TEXT NOT NULL,
    "supplied_label" TEXT,
    "room_size_square_meters" INTEGER,
    "room_category" TEXT,
    "breakfast" "breakfast_inclusion" NOT NULL,
    "occupancy_known" BOOLEAN NOT NULL,
    "taxes_known" BOOLEAN NOT NULL,
    "cancellation_known" BOOLEAN NOT NULL,
    "stay_dates_known" BOOLEAN NOT NULL,
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "stay_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flight_template" (
    "id" TEXT NOT NULL,
    "approval" "approval_state" NOT NULL,
    "source_id" TEXT NOT NULL,
    "journey" "journey_kind" NOT NULL,
    "carriers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "carrier_unresolved" BOOLEAN NOT NULL,
    "option_label" "flight_option_label" NOT NULL,
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "flight_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flight_leg" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "origin_code" TEXT,
    "destination_code" TEXT,
    "endpoint_stay_base_id" TEXT,

    CONSTRAINT "flight_leg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_profile" (
    "id" TEXT NOT NULL,
    "property_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "stated_star_rating" INTEGER,
    "guest_score" DOUBLE PRECISION,
    "guest_score_scale" TEXT,
    "provenance" "profile_provenance" NOT NULL,
    "verified" BOOLEAN NOT NULL,

    CONSTRAINT "reference_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_recommendation" (
    "id" TEXT NOT NULL,
    "approval" "approval_state" NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "tier" "recommendation_tier",
    "quality_review" BOOLEAN NOT NULL,
    "stance" TEXT,
    "body" TEXT NOT NULL,
    "property_ids" TEXT[],
    "stay_base_id" TEXT,
    "region_id" TEXT,
    "source_ids" TEXT[],
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "editorial_recommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_artifact" (
    "id" TEXT NOT NULL,
    "source_system" TEXT NOT NULL,
    "source_path" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "normalizer_version" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,

    CONSTRAINT "source_artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_record" (
    "id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "source_system" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,

    CONSTRAINT "source_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_run" (
    "id" TEXT NOT NULL,
    "normalizer_version" TEXT NOT NULL,
    "markdown_checksum" TEXT NOT NULL,
    "json_checksum" TEXT NOT NULL,
    "paris_checksum" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_finding" (
    "id" TEXT NOT NULL,
    "kind" "finding_kind" NOT NULL,
    "source_id" TEXT,
    "field" TEXT NOT NULL,
    "message" TEXT NOT NULL,

    CONSTRAINT "import_finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_hold" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_attestation" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "attested_at" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "attestation_status" NOT NULL,
    "fingerprint" JSONB NOT NULL,
    "invalidated_at" TIMESTAMP(3),

    CONSTRAINT "identity_attestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding_resolution" (
    "id" TEXT NOT NULL,
    "finding_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "resolved_at" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "finding_resolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_override" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "overridden_at" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "quality_override_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_audit" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_role" "audit_actor_role" NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "from_state" "approval_state",
    "to_state" "approval_state",
    "reason" TEXT NOT NULL,
    "error_code" TEXT,

    CONSTRAINT "approval_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historical_amount" (
    "id" TEXT NOT NULL,
    "approval" "approval_state" NOT NULL,
    "source_id" TEXT NOT NULL,
    "presentation" "historical_presentation" NOT NULL,
    "live_quote" BOOLEAN NOT NULL,
    "freshness" "historical_freshness" NOT NULL,
    "amount_minor" INTEGER,
    "currency" TEXT,
    "unit" "amount_unit" NOT NULL,
    "last_checked_at" TIMESTAMP(3),
    "last_verified_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "note" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "provider_key" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "retrieved_by" "historical_retrieval" NOT NULL,
    "admin_locked_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "historical_amount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "region_country_id_idx" ON "region"("country_id");

-- CreateIndex
CREATE UNIQUE INDEX "stay_base_slug_key" ON "stay_base"("slug");

-- CreateIndex
CREATE INDEX "stay_base_country_id_idx" ON "stay_base"("country_id");

-- CreateIndex
CREATE INDEX "stay_base_region_id_idx" ON "stay_base"("region_id");

-- CreateIndex
CREATE INDEX "area_stay_base_id_idx" ON "area"("stay_base_id");

-- CreateIndex
CREATE UNIQUE INDEX "area_stay_base_id_slug_key" ON "area"("stay_base_id", "slug");

-- CreateIndex
CREATE INDEX "place_stay_base_id_idx" ON "place"("stay_base_id");

-- CreateIndex
CREATE INDEX "curated_tip_subject_type_subject_id_idx" ON "curated_tip"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "sample_itinerary_item_itinerary_id_idx" ON "sample_itinerary_item"("itinerary_id");

-- CreateIndex
CREATE INDEX "sample_itinerary_item_place_id_idx" ON "sample_itinerary_item"("place_id");

-- CreateIndex
CREATE INDEX "stay_property_country_id_idx" ON "stay_property"("country_id");

-- CreateIndex
CREATE INDEX "stay_property_region_id_idx" ON "stay_property"("region_id");

-- CreateIndex
CREATE INDEX "stay_property_stay_base_id_idx" ON "stay_property"("stay_base_id");

-- CreateIndex
CREATE INDEX "stay_property_area_id_idx" ON "stay_property"("area_id");

-- CreateIndex
CREATE INDEX "stay_rate_property_id_idx" ON "stay_rate"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "stay_rate_source_id_rate_key_key" ON "stay_rate"("source_id", "rate_key");

-- CreateIndex
CREATE UNIQUE INDEX "flight_template_source_id_key" ON "flight_template"("source_id");

-- CreateIndex
CREATE INDEX "flight_leg_template_id_idx" ON "flight_leg"("template_id");

-- CreateIndex
CREATE UNIQUE INDEX "flight_leg_template_id_sequence_key" ON "flight_leg"("template_id", "sequence");

-- CreateIndex
CREATE INDEX "reference_profile_property_id_idx" ON "reference_profile"("property_id");

-- CreateIndex
CREATE UNIQUE INDEX "reference_profile_source_id_key" ON "reference_profile"("source_id");

-- CreateIndex
CREATE INDEX "editorial_recommendation_stay_base_id_idx" ON "editorial_recommendation"("stay_base_id");

-- CreateIndex
CREATE INDEX "editorial_recommendation_region_id_idx" ON "editorial_recommendation"("region_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_artifact_source_path_key" ON "source_artifact"("source_path");

-- CreateIndex
CREATE INDEX "source_record_artifact_id_idx" ON "source_record"("artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_record_source_system_source_id_key" ON "source_record"("source_system", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_run_normalizer_version_markdown_checksum_json_checks_key" ON "import_run"("normalizer_version", "markdown_checksum", "json_checksum", "paris_checksum");

-- CreateIndex
CREATE UNIQUE INDEX "import_finding_kind_source_id_field_message_key" ON "import_finding"("kind", "source_id", "field", "message");

-- CreateIndex
CREATE UNIQUE INDEX "import_hold_subject_type_subject_id_field_key" ON "import_hold"("subject_type", "subject_id", "field");

-- CreateIndex
CREATE INDEX "identity_attestation_subject_type_subject_id_status_idx" ON "identity_attestation"("subject_type", "subject_id", "status");

-- CreateIndex
CREATE INDEX "finding_resolution_finding_id_idx" ON "finding_resolution"("finding_id");

-- CreateIndex
CREATE UNIQUE INDEX "quality_override_subject_type_subject_id_key" ON "quality_override"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "approval_audit_subject_type_subject_id_idx" ON "approval_audit"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "historical_amount_source_id_idx" ON "historical_amount"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "historical_amount_subject_type_subject_id_key" ON "historical_amount"("subject_type", "subject_id");

-- AddForeignKey
ALTER TABLE "region" ADD CONSTRAINT "region_country_id_fkey" FOREIGN KEY ("country_id") REFERENCES "country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_base" ADD CONSTRAINT "stay_base_country_id_fkey" FOREIGN KEY ("country_id") REFERENCES "country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_base" ADD CONSTRAINT "stay_base_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "area" ADD CONSTRAINT "area_stay_base_id_fkey" FOREIGN KEY ("stay_base_id") REFERENCES "stay_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "place" ADD CONSTRAINT "place_stay_base_id_fkey" FOREIGN KEY ("stay_base_id") REFERENCES "stay_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_itinerary_item" ADD CONSTRAINT "sample_itinerary_item_itinerary_id_fkey" FOREIGN KEY ("itinerary_id") REFERENCES "sample_itinerary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sample_itinerary_item" ADD CONSTRAINT "sample_itinerary_item_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "place"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_property" ADD CONSTRAINT "stay_property_country_id_fkey" FOREIGN KEY ("country_id") REFERENCES "country"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_property" ADD CONSTRAINT "stay_property_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_property" ADD CONSTRAINT "stay_property_stay_base_id_fkey" FOREIGN KEY ("stay_base_id") REFERENCES "stay_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_property" ADD CONSTRAINT "stay_property_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stay_rate" ADD CONSTRAINT "stay_rate_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "stay_property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "flight_leg" ADD CONSTRAINT "flight_leg_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "flight_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_profile" ADD CONSTRAINT "reference_profile_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "stay_property"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_recommendation" ADD CONSTRAINT "editorial_recommendation_stay_base_id_fkey" FOREIGN KEY ("stay_base_id") REFERENCES "stay_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_recommendation" ADD CONSTRAINT "editorial_recommendation_region_id_fkey" FOREIGN KEY ("region_id") REFERENCES "region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_record" ADD CONSTRAINT "source_record_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "source_artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding_resolution" ADD CONSTRAINT "finding_resolution_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "import_finding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Historical amounts are internal reference data. They cannot become a live or indicative price.
ALTER TABLE "historical_amount" ADD CONSTRAINT "historical_amount_internal_only" CHECK (
  "presentation" = 'historical_reference'
  AND "live_quote" = false
  AND "freshness" = 'unverified'
  AND "last_verified_at" IS NULL
  AND "expires_at" IS NULL
  AND "retrieved_by" = 'manual'
);

ALTER TABLE "historical_amount" ADD CONSTRAINT "historical_amount_subject_kind" CHECK (
  "subject_type" IN ('stay_rate', 'flight_template')
);
