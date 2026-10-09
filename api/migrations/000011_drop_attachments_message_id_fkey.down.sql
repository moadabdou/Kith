ALTER TABLE attachments ADD CONSTRAINT attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL;
