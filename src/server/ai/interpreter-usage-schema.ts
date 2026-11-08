/**
 * Column shape used by isolated limiter tests.
 * The reviewed migration is prisma/migrations/20261101230000_interpreter_usage_bucket/migration.sql.
 * That migration has not been applied to Supabase.
 */
export const INTERPRETER_USAGE_SCHEMA_SQL = `
CREATE TABLE interpreter_usage_bucket (
  bucket_key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL,
  CONSTRAINT interpreter_usage_bucket_count_nonnegative CHECK (request_count >= 0)
);
`;
