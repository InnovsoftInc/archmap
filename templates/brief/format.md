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
| `services` | `kind` (`app`, `api`, `worker`, `job`); `connects` (`to`, `why`, `how`, `status`, `evidence`); `endpoints` (`route`, `evidence`); `jobs` (`name`, `schedule`, `evidence`); `libraries` (`name`, `why`, `evidence`) |
| `stores`   | `kind` (`database`, `queue`, `bucket`, `cache`); `connects`; `tables` (`name`, `group`, `purpose`, `evidence`, `columns`); `enums` (`name`, `values`, `evidence`)                                                  |
| `external` | `kind` (`auth`, `email`, `payments`, `ai`, `hosting`, `other`); `connects`                                                                                                                                         |
| `personas` | `roles` (the auth roles that map to it: `name`, `evidence`), `needs`                                                                                                                                               |
| `flows`    | `persona`, `steps` (each `{ by, at, does }`, where `by` is a persona or service id and `at` is a service, store or external id)                                                                                    |

A column is `{ name, type, pk, unique, fk, enum, desc, evidence }`; a column's
`enum` names an enum in the same store. `connects[].to` is the id of a service,
store or external. A `connects` entry's `status` (`live`, `planned` or
`retiring`, default `live`) marks a connection that is not built yet or is
going away; no other list entry has a status. Any key not listed here is an
error, in list entries too.

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
    evidence: apps/api/src/applications/controller.ts#create
  - route: GET /applications/:id
    evidence: apps/api/src/applications/controller.ts#get
jobs:
  - name: reminder-emails
    schedule: daily at 09:00
    evidence: apps/api/src/jobs/reminders.ts#sendReminders
libraries:
  - name: Express
    why: HTTP framework
    evidence: apps/api/src/server.ts#express
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
cover yet. A lead is confirmed by evidence that cites its file, and by its own
match: an app by a `code` entry at or inside its path, a route by an `endpoints`
route, a table by a store table's name, an outside service by an external's id
or name, and an infrastructure, Docker or CI lead by a `code` entry that is its
file or a folder above it. A lead that is not part of the architecture goes in
`ignore` in `archmap.config.json`: each entry is a lead key
(`scan:<kind>:<name>@<file>`, listed by `scan`) or a pattern split at its last
`@`. In the name part `*` matches any characters, `/` included; the file part
is a glob. So `scan:route:*@apps/api/**` covers every route in `apps/api`. An
entry without `@<file>` matches that lead in every file.
