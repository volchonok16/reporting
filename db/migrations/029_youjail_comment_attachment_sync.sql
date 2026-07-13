-- Файлы из комментариев должны быть видны в общих вложениях карточки.
INSERT INTO youjail_attachment (card_id, filename, storage_path, content_type, size_bytes, created_at)
SELECT c.card_id,
       ca.filename,
       ca.storage_path,
       ca.content_type,
       ca.size_bytes,
       ca.created_at
FROM youjail_comment_attachment ca
JOIN youjail_card_comment c ON c.id = ca.comment_id
WHERE NOT EXISTS (
    SELECT 1
    FROM youjail_attachment a
    WHERE a.card_id = c.card_id
      AND a.storage_path = ca.storage_path
);
