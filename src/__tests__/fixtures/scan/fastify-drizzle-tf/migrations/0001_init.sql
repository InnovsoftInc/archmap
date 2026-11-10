CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  "action" TEXT NOT NULL,
  CONSTRAINT audit_fk FOREIGN KEY (id) REFERENCES accounts (id)
);
