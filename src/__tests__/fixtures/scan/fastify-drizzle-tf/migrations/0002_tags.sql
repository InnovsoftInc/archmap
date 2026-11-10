-- tags
CREATE TABLE tags (id INT, name TEXT);
CREATE INDEX tags_name ON tags (name);
INSERT INTO tags VALUES (1, 'x');
-- done
CREATE TABLE posts (
  id INT,
  title TEXT);
ALTER TABLE posts ADD COLUMN body TEXT;
