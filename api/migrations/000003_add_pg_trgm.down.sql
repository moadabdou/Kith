-- 000003_add_pg_trgm.down.sql — Rollback trigram GIN index

DROP INDEX IF EXISTS messages_content_trgm_idx;
DROP EXTENSION IF EXISTS pg_trgm;
