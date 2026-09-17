# Wanderer

A self-hosted map for saving places. Drop a pin, add a note and some tags, then filter the map by
tag. Multiuser, on your own server or web hosting. The map data comes from OpenFreeMap's public tiles, which can
also be self-hosted.

I built this as a portfolio project, to show a backend with real architecture behind it rather than
plain CRUD. The main pieces are dependency injection, a layered structure, interfaces, PostGIS, and
JWT auth. The frontend is plain vanilla JS with no build step.

<img width="804" height="655" alt="gif" src="https://github.com/user-attachments/assets/f85a1437-b397-4f23-b3d2-05cf5948163b" />


## Stack

- PHP 8.3, Slim 4, PHP-DI
- PostgreSQL and PostGIS
- firebase/php-jwt, bcrypt
- Phinx (migrations)
- PHPUnit, PHPStan (level 8), php-cs-fixer
- Vanilla JS and MapLibre GL JS, OpenFreeMap tiles

## Architecture

A request runs through these layers, top to bottom.

1. nginx and PHP-FPM take the request.
2. The app factory in `config/bootstrap.php` builds the container and the app.
3. PSR-15 middleware verifies the JWT and attaches the user id, or returns 401.
4. A controller for that one endpoint validates the input, sets the status, and serializes the response.
5. A repository runs owner-scoped SQL behind an interface.
6. PDO talks to PostgreSQL and PostGIS.

Some points worth mentioning:

- One action class per endpoint.
- Repositories sit behind interfaces, so tests can pass in fakes.
- Queries are scoped to the owner, and the owner id comes from the token rather than the request body.
- Entities are immutable. `Coordinates` range-checks itself in the constructor.
- Database errors such as a unique violation become domain exceptions inside the repository.
- Everything is wired in one app factory, `config/bootstrap.php`. The tests reuse it, so they boot
  the app the same way it runs in production.

Auth is a JWT in the `Authorization` header. The algorithm is pinned. The secret must meet a minimum
length, checked at startup. The `iss` and `aud` claims are verified. Register and login
return the same response whether or not an email exists, and login runs a password hash on both paths
so the response time does not give it away either.

## Setup

Needs PHP 8.3 or newer with the `intl`, `pdo_pgsql` and `mbstring` extensions, Composer, and
PostgreSQL with PostGIS.

```
composer install
cp .env.example .env
```

Open `.env` and set the database values. The example ships with `DB_NAME=mapapp`, `DB_USER=changeme`,
`DB_PASS=changeme`, `DB_HOST=localhost` and `DB_PORT=5432`. Change the user and password for anything
beyond a local machine. Then generate a secret and paste it into `JWT_SECRET`:

```
php -r "echo bin2hex(random_bytes(64)), PHP_EOL;"
```

Create the database and run the migrations:

```
createdb mapapp
vendor/bin/phinx migrate
```

The migrations try to enable the `postgis` and `citext` extensions. On many shared hosts, and on
PostgreSQL 15 and newer, an ordinary database user is not allowed to create extensions or to create
tables in the `public` schema, so the migration fails on the first extension. If that happens, set the
database up by hand as a superuser first:

```sql
-- run in psql as a superuser, for example the postgres role
CREATE DATABASE mapapp;
CREATE USER changeme WITH PASSWORD 'changeme';
GRANT ALL PRIVILEGES ON DATABASE mapapp TO changeme;

\c mapapp
GRANT ALL ON SCHEMA public TO changeme;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;
```

Those names match the placeholder values in `.env.example`. Once they are set in `.env`, run
`vendor/bin/phinx migrate` again. The extensions already exist, so it skips them and creates the
tables.

Serve the `public/` directory with nginx and PHP-FPM. nginx serves `index.html` and the static files
directly, and passes `/api` to `public/index.php`.

For local development without a mail server, set `AUTO_VERIFY_NEW_ACCOUNTS=true`. New accounts are
then created already verified. With `MAIL_TRANSPORT=log`, anything the app would email, such as a
resent verification link, is written to the log instead. There is no SMTP transport yet. Only `log`
and `memory` exist, so `MAIL_TRANSPORT=smtp` does nothing for now. Real mail is on the roadmap.

## Tests

Unit tests, plus functional tests that run against a real PostgreSQL. Each functional test runs in a
transaction and rolls back afterward, so it leaves no data behind. The functional tests need their own
database. As a safeguard, the suite refuses to run unless `DB_NAME` ends in `_test`.

Copy the test env file. It ships pointing at the `mapapp_test` database. Set `JWT_SECRET` in
`.env.test` as well, the same way as in Setup above.

```
cp .env.test.example .env.test
```

Then run the migrations against the test database and the suite:

```
APP_ENV=test vendor/bin/phinx migrate
vendor/bin/phpunit
```

If the extension step fails here too, create the test database as a superuser first, the same way as
in Setup above. The `changeme` user already exists from Setup, so there is no need to create it again.

```sql
CREATE DATABASE mapapp_test;
GRANT ALL PRIVILEGES ON DATABASE mapapp_test TO changeme;

\c mapapp_test
GRANT ALL ON SCHEMA public TO changeme;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS citext;
```

Then run `APP_ENV=test vendor/bin/phinx migrate` and `vendor/bin/phpunit` again.

## Roadmap

- Refresh tokens. The JWT is kept in memory right now, so refreshing the page logs you out.
- SMTP mail transport. Only the `log` and `memory` transports exist, so verification emails are not
  actually sent yet.
- GeoJSON markers with clustering and Bounding box queries.
- More advanced filtering. Tag filtering is any or all today. The plan is nested and/or conditions.
- Photo upload. The UI is there but disabled, with nothing behind it yet.
- A `GET /api/me` endpoint. Profile currently shows the email carried over from login.
- Nearby search with `ST_DWithin`.

## License

MIT
