Record what this branch changed on the map. Read the changes listed below, and
every map file listed against them. Follow any new connections the changes
introduce (a new client, queue, table, route or outside service) to their other
end. Update those map files, and add new ones for anything new.

Two things in the check results below need you in particular. An entry that
"may be out of date" cites code this branch changed while the entry stayed the
same: re-read that code, and correct the entry's `does`, `params`, `body`,
`returns`, `why` or whatever no longer holds. If it still holds, leave it. An
endpoint that "is new and needs" something must be documented before the check
passes: write its `does`, and a `params` entry for each name in its path.
