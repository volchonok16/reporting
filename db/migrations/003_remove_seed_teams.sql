-- Удалить примеры команд из ранней версии схемы (digital, berkhut были только иллюстрацией)
-- docker-compose exec -T postgres psql -U reporting -d reporting < db/migrations/003_remove_seed_teams.sql

DELETE FROM source_team_mapping
WHERE team_id IN (SELECT id FROM team WHERE code IN ('digital', 'berkhut'));

UPDATE project SET team_id = NULL
WHERE team_id IN (SELECT id FROM team WHERE code IN ('digital', 'berkhut'));

UPDATE task SET team_id = NULL
WHERE team_id IN (SELECT id FROM team WHERE code IN ('digital', 'berkhut'));

DELETE FROM team WHERE code IN ('digital', 'berkhut');
