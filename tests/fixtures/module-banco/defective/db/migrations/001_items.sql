CREATE TABLE public.items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_code bigint NOT NULL,
  obsolete_note text,
  payload text NOT NULL
);
