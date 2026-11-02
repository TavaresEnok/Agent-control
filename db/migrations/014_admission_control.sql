CREATE TABLE ac_admission_control(id integer PRIMARY KEY CHECK(id=1), enabled boolean NOT NULL,
 revision integer NOT NULL CHECK(revision>0), reason text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO ac_admission_control VALUES(1,true,1,'fresh-isolated-installation',now());
