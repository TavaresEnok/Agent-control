-- Dedicated per-project exam contexts for design and security verification so CLI exams coexist with the live manager.
CREATE TABLE ac_exam_contexts (
  project_id uuid NOT NULL REFERENCES ac_projects,
  module text NOT NULL CHECK (module IN ('design', 'verify')),
  context_id uuid NOT NULL UNIQUE REFERENCES ac_contexts,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, module)
);
