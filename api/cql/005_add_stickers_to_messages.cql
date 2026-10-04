-- 005_add_stickers_to_messages.cql
USE kith;

ALTER TABLE messages ADD sticker_ids list<text>;
