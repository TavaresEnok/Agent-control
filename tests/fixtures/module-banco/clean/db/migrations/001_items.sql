CREATE TABLE public.items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_code bigint NOT NULL,
  obsolete_note text,
  payload text NOT NULL
);
CREATE INDEX items_item_code_idx ON public.items (item_code);
