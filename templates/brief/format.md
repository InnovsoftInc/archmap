The map is a folder of markdown files, one per thing:

```
architecture/
  archmap.config.json   name, branding, pinned archmap version, agent, ignore list, deploy
  README.md             start here: what the product is, who it's for, a short tour, links
  services/<id>.md      apps, APIs, workers, scheduled jobs
  stores/<id>.md        databases, queues, buckets, with their tables, columns and enums
  external/<id>.md      outside services: sign-in, email, payments, AI, hosting
  personas/<id>.md      each kind of user and what they need
  flows/<id>.md         the main journeys: who does what, in which service
```

The file name is the id: lowercase letters, digits and hyphens. Files point at
each other by id. One file per store, with its tables, columns and enums in that
file's frontmatter.

Each file is YAML frontmatter, then a markdown body. The frontmatter holds the
facts the diagrams need:

| Folder     | Frontmatter fields                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| every file | `name`, `status` (`live`, `planned` or `retiring`), `code` (the paths it covers; empty for `external` and `personas`)                                                                                              |
| `services` | `kind` (`app`, `api`, `worker`, `job`); `connects` (`to`, `why`, `how`, `status`, `evidence`); `endpoints` (`route`, `does`, `auth`, `params`, `body`, `returns`, `evidence`); `jobs` (`name`, `does`, `schedule`, `evidence`); `libraries` (`name`, `package`, `why`, `evidence`; `package` is the name in the app's manifest when it differs from `name`, such as `Logging` → `pino`. archmap reads the version from the manifest, so don't write one); `env` (the environment variables the service reads: `name`, `why`, `public`, `evidence`; names only, never values, and `public: true` when the value is shipped to the browser) |
| `stores`   | `kind` (`database`, `queue`, `bucket`, `cache`); `connects`; `tables` (`name`, `group`, `purpose`, `evidence`, `columns`); `enums` (`name`, `values`, `evidence`)                                                  |
| `external` | `kind` (`auth`, `email`, `payments`, `ai`, `hosting`, `secrets`, `monitoring`, `ci`, `dns`, `other`); `connects`                                                                                                                                         |
| `personas` | `roles` (the auth roles that map to it: `name`, `evidence`), `needs`                                                                                                                                               |
| `flows`    | `persona`, `steps` (each `{ by, at, does }`, where `by` is a persona or service id and `at` is a service, store or external id)                                                                                    |

The overview groups services, stores and external files into lanes, placed from what they already say: `kind: app` goes to Frontend; APIs, workers, jobs and stores to Backend; external `kind` `hosting`, `secrets`, `monitoring`, `ci` or `dns` to Platform and delivery; other external services to Third-party and partners, or to Legacy when `status: retiring`. Don't add `lane` unless a file belongs somewhere else; then use one of the lane ids in `archmap.config.json` (`frontend`, `backend`, `platform`, `third_party`, `legacy` by default).

A column is `{ name, type, pk, unique, fk, enum, desc, evidence }`; a column's
`enum` names an enum in the same store. `connects[].to` is the id of a service,
store or external. A `connects` entry's `status` (`live`, `planned` or
`retiring`, default `live`) marks a connection that is not built yet or is
going away; no other list entry has a status. Any key not listed here is an
error, in list entries too.

**Endpoints document themselves.** Clicking an endpoint in the viewer shows how
to call it, so write for someone about to: `does` is one or two plain sentences
on what it does; `auth` is who may call it (`anyone`, `signed-in user`, `admin
role`, `API key`); `params` are what goes in the path, query or headers, each
`{ name, in, type, required, desc }` with `in` one of `path`, `query`,
`header`; `body` is the request body's fields, each `{ name, type, required,
desc }` (write a nested field as `address.city`); `returns` is what comes back,
and the errors worth knowing. Read them from the handler and its validation,
never guess: leave out what the code doesn't show. A job's `does` and an `env`
entry's `why` say the same for those: what the job does each run, and what the
variable controls and what breaks without it.

**Evidence.** Every `connects`, `endpoints`, `jobs`, `tables` and `columns`
entry, and every `roles` entry, has an `evidence` field: a repo-relative path,
optionally with `#Symbol` (the symbol must appear in the file as a whole
identifier, at least 3 characters long). A file whose
`status` is `planned`, or a `connects` entry whose `status` is `planned`, may
leave it out. A column may leave it out when its table has it.

```yaml
connects:
  - to: sendgrid
    why: application emails
    evidence: apps/api/src/mail/client.ts#SendGridClient
endpoints:
  - route: POST /applications
    evidence: apps/api/src/applications/controller.ts#create
```

**Every body uses the same headings, in reading order:**

1. A plain summary anyone can follow (no heading, the first paragraph). For everyone.
2. `## How it works`, for the team: how the pieces behave and why.
3. `## For developers`: where to start in the code, how to run it, what to watch out for.

`personas/` and `external/` files need only the summary.

A complete example, `services/api.md`:

```markdown
---
name: API
status: live
kind: api
code:
  - apps/api
connects:
  - to: main-db
    why: stores applications and users
    evidence: apps/api/src/db/client.ts#createPool
  - to: sendgrid
    why: application emails
    evidence: apps/api/src/mail/client.ts#SendGridClient
endpoints:
  - route: POST /applications
    does: Submits a new application and emails the applicant a confirmation.
    auth: signed-in applicant
    body:
      - name: programId
        type: uuid
        required: true
        desc: the program being applied to
      - name: answers
        type: object
        required: true
        desc: the form answers, keyed by question id
    returns: 201 with the new application; 422 when an answer is missing
    evidence: apps/api/src/applications/controller.ts#create
  - route: GET /applications/:id
    does: Returns one application with its current status.
    auth: the applicant who owns it, or staff
    params:
      - name: id
        in: path
        type: uuid
        required: true
        desc: the application's id
    returns: the application; 404 when it isn't theirs
    evidence: apps/api/src/applications/controller.ts#get
jobs:
  - name: reminder-emails
    does: Emails applicants whose application is still incomplete.
    schedule: daily at 09:00
    evidence: apps/api/src/jobs/reminders.ts#sendReminders
libraries:
  - name: Express
    why: HTTP framework
    evidence: apps/api/src/server.ts#express
env:
  - name: DATABASE_URL
    why: connection string for the main database; the API won't start without it
    evidence: apps/api/src/db/client.ts#createPool
  - name: SENDGRID_API_KEY
    why: lets the API send email through SendGrid; without it no email goes out
    evidence: apps/api/src/mail/client.ts#SendGridClient
---

The API is the back end the web app talks to. It takes applications from
applicants, keeps them, and emails people about what happens next.

## How it works

Applicants submit a form in the web app, which calls `POST /applications`. The
API saves it in the main database and sends a confirmation through SendGrid. A
daily job reminds applicants whose application is still incomplete.

## For developers

Start in `apps/api/src/server.ts`. Run it with `pnpm --filter api dev`; it needs
`DATABASE_URL` and `SENDGRID_API_KEY` configured (see `.env.example`).
Controllers live next to their feature folder; the reminder job runs from the
scheduler in `apps/api/src/jobs`.
```

**Leads.** Check warns about each thing the scanner found that the map doesn't
cover yet. Each kind is confirmed its own way: an app by a `code` entry at or
inside its path; a route by an `endpoints` route; a table by a store table's
name; an outside service by an external whose id or name is the service name or
starts with it (`azure-blob` covers `Azure`); an environment variable from
`.env.example` by a service's `env` entry with its name, or its name appearing
in an external's frontmatter or any doc's body; an environment variable that code reads by an `env` entry with its name
in the doc whose `code` covers that file, so each app's doc lists the variables
that app needs (names only, never values, with `public: true` on the ones
shipped to the browser; a mention in that doc's body also counts); and an infrastructure, Docker or CI lead by a `code` entry that is its
file or a folder above it. Evidence that cites a lead's file confirms only app,
infrastructure, Docker and CI leads: a new route or table in a file the map
already cites is still a lead. A lead that is not part of the architecture goes in
`ignore` in `archmap.config.json`: each entry is a lead key
(`scan:<kind>:<name>@<file>`, listed by `scan`) or a pattern split at its last
`@`. In the name part `*` matches any characters, `/` included; the file part
is a glob. So `scan:route:*@apps/api/**` covers every route in `apps/api`. An
entry without `@<file>` matches that lead in every file.
