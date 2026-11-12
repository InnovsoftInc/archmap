Record what someone joining the project needs in order to understand how it
fits together. Leave out how each piece is written inside. The map has four
layers; put each change in the layer it belongs to.

1. **Overview**: every app or service the project deploys, every database,
   queue or file store, every outside service it calls (sign-in, email,
   payments, AI, hosting), and the connections between them. Update it when
   one of these is added, removed, replaced or moved.
2. **Parts**: inside each app, every endpoint it serves (method and path), every
   background or scheduled job, and every storage container (bucket, queue,
   topic). Libraries and tools only when they shape the architecture: the
   framework, auth, database access, payments, messaging, observability. Not
   general utilities.
3. **Data**: every table and column in the databases the project owns, and every
   enum they use. Not indexes (except unique constraints), migrations or views.
4. **People and flows**: one persona per kind of user the product serves (the
   roles in its auth, or the people a brief names), what each needs to get done,
   and the main journeys through the services: signing up, the product's core
   jobs, paying. Not every screen or click.

Record a change when code adds, removes, renames or rewires one of these, or
when a decision is made about one that isn't built yet (`status: planned`), or
is being phased out (`status: retiring`). A refactor, a test, or a change
inside a file that leaves all of the above as it was needs no update to the
map files.

Never put on the map: secrets, keys, tokens, passwords or environment values;
personal data; internal hostnames or URLs that include credentials; UI
components, helper functions, test fixtures or one-off scripts; anything that's
only an idea nobody has decided on.
