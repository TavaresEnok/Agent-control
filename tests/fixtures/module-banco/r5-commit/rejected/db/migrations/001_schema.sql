CREATE TABLE parent (id integer PRIMARY KEY);
CREATE TABLE child (
  parent_id integer,
  CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES parent(id)
    DEFERRABLE INITIALLY DEFERRED
);
