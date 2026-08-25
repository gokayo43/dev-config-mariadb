# The server the database job grades

`database: external` adds the `database` job, and this is its first step: the server
every gate after it uses, started from the image the consuming repo pinned and
left running for them. It decides nothing about the repo under grade — what it
refuses is a call that could not have worked.

## Which server a consumer gets

Whichever they pin:

```yaml
with:
  database: external
  database-image: mysql:8.0.42@sha256:… # or a mariadb one, or nothing at all
```

The input defaults to the MariaDB build this repo certifies, so a consumer on
MariaDB writes nothing. A consumer on MySQL 8 writes one line, and it is their
own pin: this repo does not maintain a list of blessed images, and nothing here
infers a product from what the reference is called. Both products are certified
by this repo's own suite, which runs every server-touching case against a real
MariaDB **and** a real MySQL 8 in one `bun test`.

The digest is the consumer's discipline, and it is the whole contract: an image
pinned by tag can be repointed by its publisher, and a gate whose server changed
under it is a gate that grades a different thing every week. `check.yml`'s own
default is held to the digest rule by `tests/wrapper-inputs.test.ts`.

## Why it is a step and not a service container

A service container would be the obvious home for it, and it was one until the
server became the consumer's to choose. `services.<id>.image` is a literal:
dev-config's pin gate reads it and refuses anything that is not a `@sha256:`
digest, so an expression there — an input — is reported as a mutable tag.
[dev-config#68](https://github.com/gokayo43/dev-config/issues/68) is that hole;
until it moves, a workflow that wants a caller-declared server cannot declare it
as a service.

What that costs, stated plainly: the runner health-checks a service container
and refuses to start the job's steps until it passes, and it starts one in
parallel with the job's checkout. A step does neither. So this step polls the
server itself and blocks until it answers — the same wait, spent in series
rather than in parallel. Measured from `docker run` to the first query answered,
image already local: 10s on the MariaDB pin, 25s on the MySQL 8 one, plus
whatever the image pull costs a cold runner. The step's own bound is two
minutes.

What it buys back is that the wait is this repo's code rather than a health
command in YAML: it is graded by `tests/server.test.ts` against both products,
including the ways it can go wrong.

## What it does

1. Reclaims the container name, so a run killed outright does not leave one for
   the next run to collide with.
2. Starts the image, publishing 3306 on the loopback port `database-url` names,
   with the root password and the database name read out of that same URL. The
   environment variables are `MYSQL_ROOT_PASSWORD` and `MYSQL_DATABASE`, which
   are the two names **both** images read — the MariaDB image keeps them for
   compatibility, and no MySQL image has ever had the `MARIADB_` spellings.
3. Polls until a query answers, and reports the server's own `version()` in the
   note it leaves behind.

The poll is a query rather than a ping through the image's client, and that is
what makes this one step rather than two shapes of one: the products have no
client binary name in common. It is also the stronger question — both images run
a temporary server with networking off while they initialise, so a port that
answers is a server past that, and a query proves the account and the database
the later gates were handed are the ones this container came up with.

## What it refuses

- **An empty `database-image`.** A composite action maps a missing input to the
  empty string, so `required: true` is a promise nothing enforces at runtime.
- **A `database-url` naming a host this step does not publish on**, or an
  account the image never creates. Neither is something the step could satisfy
  by trying harder: it publishes on 127.0.0.1, and the image initialises exactly
  one account from the password it is given. `check.yml` passes neither; a
  caller running the action directly is who they are for.
- **A container that came up and stopped**, with the server's own output relayed
  under it. This is the failure a service container could not have: the runner
  would have refused to start the job. Reported as what it is rather than as a
  timeout, because the reason is in the image's first lines.
- **A server that never answers within the bound** — two minutes — with its
  output relayed the same way.

## What it cannot catch

- **That the pinned image is the product the consumer runs in production.** It
  starts what it is given and says what that turned out to be; a consumer who
  pins MySQL 8.4 while running 8.0 has certified 8.4.
- **Anything about the server's configuration.** A stock image is not a
  production server: `sql_mode`, character sets and buffer sizes are all the
  image's defaults, and a schema that applies here can fail on a server
  configured differently.
- **A server that answers and then dies.** The check is at the start; a gate
  that later meets a dead server reports a refused connection, and the evidence
  artifact is where the run's own output is.
