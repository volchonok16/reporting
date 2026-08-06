ALTER TABLE planning_project
    ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'in_progress', 'completed'));

CREATE INDEX IF NOT EXISTS idx_planning_project_status ON planning_project (status);

COMMENT ON COLUMN planning_project.status IS 'Статус проекта: new, in_progress, completed';
