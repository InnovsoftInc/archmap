Set the project up with the person before you read any code. Ask these
questions in one message, each with its default, and wait for the answers. If
the person already answered them in this conversation, or says to use the
defaults, don't ask again.

1. **Which branch should the map describe?** The first map is written from that
   branch's code, and every later pull request into it is checked against the
   map. Default: `__BASE__`__BASE_NOTE__. __BRANCHES__
2. **Should pull requests be checked?** The check fails a pull request that
   changes the architecture without updating the map. It can run on GitHub
   Actions or Azure Pipelines, or not at all. Default: __CI__.
3. **Should an agent update the map on each pull request?** The same workflow
   can run an agent that updates the map and pushes it to the pull request's
   branch, so the map keeps itself current. It needs an `ANTHROPIC_API_KEY`
   secret in the repository's CI settings. Without it the check still runs, and
   whoever opened the pull request asks their own agent to update the map.
   Default: yes, when pull requests are checked.
4. **What should the map be called?** Default: `__NAME__`.

Then set the project up, in this order. These steps are the one exception to
"edit only files in the map folder".

1. Start from the chosen branch: run `git fetch`, then
   `git switch -c archmap/setup origin/<branch>` (from the local branch when it
   has no remote). Files archmap has already written come along. If git refuses
   because of other uncommitted work, stop and tell the person what is in the
   way.
2. Run `__CLI__ init --base <branch> --name "<name>"`, with `--ci github` or
   `--ci azure` when they chose a check, and `--claude` when you are Claude
   Code. It is safe to run again: it updates what is already there.
3. Write the map: the task below. Run `check` until it passes.
4. Show the person the map, as the archmap section of `AGENTS.md` says, and
   tell them what you found.
5. Ask before you commit, push `archmap/setup` and open a pull request into
   `<branch>`. Never push or open one without a yes.
6. Tell them what happens next. With the check on, every pull request into
   `<branch>` is checked against the map. With the agent on, remind them to add
   the `ANTHROPIC_API_KEY` secret (GitHub: Settings, Secrets and variables,
   Actions; Azure: a secret pipeline variable), since nothing updates the map on
   a pull request until it is there. With the check off, the map is updated
   whenever an agent follows `AGENTS.md` after a change.
