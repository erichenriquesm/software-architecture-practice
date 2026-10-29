# Whole platform: shared infra (RabbitMQ, Redis, edge) + every service in backend/.
# Each service lives in its own repository and is cloned into backend/<service>/ by `make clone` at the root
# (which also starts the front with the backend); each one has its own Makefile for its migrations and tests.
#
#   make up                 create missing .env files and editor dependencies, build and start everything, then migrate every service
#   make watch              same, in the foreground with Compose Watch (code changes without rebuild)
#   make infra              start only the shared infra
#   make migrate            run the pending migrations of every service
#   make ps                 list the containers and their health
#   make logs [s=account-api]   follow the logs (of one container when s= is given)
#   make down               stop everything (volumes are kept)
#   make projections-rebuild   rebuild the market-data projections from what matching republishes (platform up)
#   make test               every kind of test of every service (static checks, unit, integration, contract) + make check
#   make e2e                start and migrate the platform, then run the end-to-end tests through the edge
#   make check              every contract copy matches its owner's original (the root layout is checked by the root Makefile)
#   make env                create each .env from its .env.example when it does not exist yet
#   make deps               node_modules + generated gRPC code of every service on your machine, for the editor

COMPOSE = docker compose -f docker-compose.yml
SERVICES = $(patsubst %/Makefile,%,$(wildcard */Makefile))
ENV_EXAMPLES = $(wildcard infra/.env.example */.env.example */.env.test.example)

.PHONY: up watch infra migrate ps logs down check env deps deps-missing test e2e projections-rebuild

env:
	@for example in $(ENV_EXAMPLES); do \
	  target=$${example%.example}; \
	  if [ ! -f "$$target" ]; then cp "$$example" "$$target" && echo "created $$target"; fi; \
	done

up: env deps-missing
	$(COMPOSE) up -d --build --wait
	@$(MAKE) --no-print-directory migrate

watch: env deps-missing
	$(COMPOSE) up --build --watch

infra: env
	docker compose -f infra/docker-compose.yml up -d --wait

migrate:
	@for service in $(SERVICES); do \
	  echo "== $$service"; \
	  $(MAKE) --no-print-directory -C $$service migrate || exit 1; \
	done

test: env
	@for service in $(SERVICES); do \
	  echo "== $$service"; \
	  $(MAKE) --no-print-directory -C $$service test || exit 1; \
	done
	@$(MAKE) --no-print-directory check

e2e: up
	cd e2e && docker compose run --rm e2e

# Only the services whose node_modules is missing (a new service, a fresh clone): keeps `make up` fast.
deps-missing:
	@for service in $(SERVICES); do \
	  if [ ! -d "$$service/node_modules/@types/node" ]; then echo "== $$service (editor dependencies)"; $(MAKE) --no-print-directory -C $$service deps || exit 1; fi; \
	done

deps:
	@for service in $(SERVICES); do \
	  echo "== $$service"; \
	  $(MAKE) --no-print-directory -C $$service deps || exit 1; \
	done

ps:
	$(COMPOSE) ps --format 'table {{.Name}}\t{{.Status}}'

logs:
	$(COMPOSE) logs -f $(s)

down:
	$(COMPOSE) down

# The broker keeps no history: matching republishes its trades and books on matching.replay.* and
# market-data applies them until the replayCompleted marker (sdd/03-mensageria.md §8).
projections-rebuild:
	$(MAKE) -C market-data projections-rebuild-prepare
	$(MAKE) -C matching history-republish
	$(MAKE) -C market-data projections-rebuild

check:
	docker run --rm -v "$(CURDIR)":/backend -w /backend node:26-alpine npx --yes tsx scripts/check-schemas.ts .
