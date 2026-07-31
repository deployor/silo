INSERT OR REPLACE INTO component_uptime_checks (
  component_id,
  operational,
  planned_maintenance,
  recorded_at
)
SELECT
  'pgpool:' || substr(component_id, length('pgdog:') + 1),
  operational,
  planned_maintenance,
  recorded_at
FROM component_uptime_checks
WHERE component_id LIKE 'pgdog:%';

DELETE FROM component_uptime_checks
WHERE component_id LIKE 'pgdog:%';
