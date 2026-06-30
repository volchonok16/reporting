CREATE TABLE IF NOT EXISTS org_chart_layout (
    id              BIGSERIAL PRIMARY KEY,
    scope           VARCHAR(32) NOT NULL CHECK (scope IN ('company', 'department')),
    department_id   BIGINT REFERENCES department(id) ON DELETE CASCADE,
    layout_json     JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (scope, department_id),
    CHECK (
        (scope = 'company' AND department_id IS NULL)
        OR (scope = 'department' AND department_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_org_chart_layout_company
    ON org_chart_layout (scope)
    WHERE scope = 'company';

COMMENT ON TABLE org_chart_layout IS 'Сохранённая ручная раскладка оргсхемы';
