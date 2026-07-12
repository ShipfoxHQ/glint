CREATE TABLE glint_migration_order (
  position integer PRIMARY KEY,
  module_name text NOT NULL
);
--> statement-breakpoint
INSERT INTO glint_migration_order (position, module_name) VALUES (1, 'foundation');
