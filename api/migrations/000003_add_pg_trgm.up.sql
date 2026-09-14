-- 000003_add_pg_trgm.up.sql — Search Rung 1: Trigram GIN index for full-text search (plan/04 §2)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS messages_content_trgm_idx ON messages USING gin (content gin_trgm_ops);
