-- Удаление YouJail (вкладка «Доска») из проекта.
-- ./scripts/migrate.sh db/migrations/095_drop_youjail.sql

DROP TABLE IF EXISTS youjail_comment_attachment CASCADE;
DROP TABLE IF EXISTS youjail_card_comment CASCADE;
DROP TABLE IF EXISTS youjail_card_link CASCADE;
DROP TABLE IF EXISTS youjail_card_event CASCADE;
DROP TABLE IF EXISTS youjail_card_zni CASCADE;
DROP TABLE IF EXISTS youjail_card_tag CASCADE;
DROP TABLE IF EXISTS youjail_tag CASCADE;
DROP TABLE IF EXISTS youjail_execution_log CASCADE;
DROP TABLE IF EXISTS youjail_execution CASCADE;
DROP TABLE IF EXISTS youjail_attachment CASCADE;
DROP TABLE IF EXISTS youjail_card CASCADE;
DROP TABLE IF EXISTS youjail_column CASCADE;
DROP TABLE IF EXISTS youjail_task_type CASCADE;
DROP TABLE IF EXISTS youjail_project CASCADE;
DROP TABLE IF EXISTS youjail_board_pin CASCADE;
DROP TABLE IF EXISTS youjail_board_member CASCADE;
DROP TABLE IF EXISTS youjail_board_team CASCADE;
DROP TABLE IF EXISTS youjail_team_member CASCADE;
DROP TABLE IF EXISTS youjail_team CASCADE;
DROP TABLE IF EXISTS youjail_board CASCADE;

DELETE FROM org_user_page_access WHERE page_key IN ('youjail-board', 'diagrams');
UPDATE app_page
SET is_active = FALSE, updated_at = NOW()
WHERE page_key IN ('youjail-board', 'diagrams');
