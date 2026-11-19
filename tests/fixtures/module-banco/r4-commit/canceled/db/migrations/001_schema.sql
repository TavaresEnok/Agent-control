CREATE TABLE items (id integer PRIMARY KEY);

CREATE FUNCTION cancel_own_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_cancel_backend(pg_backend_pid());
  PERFORM pg_sleep(0.1);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER check_items
  AFTER INSERT ON items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cancel_own_check();
