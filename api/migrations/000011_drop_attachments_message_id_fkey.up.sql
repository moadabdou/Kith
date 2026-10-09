-- Drop foreign key constraint on messages(id) because messages are partitioned and stored in ScyllaDB when running in Scylla/dual-write mode
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_message_id_fkey;
