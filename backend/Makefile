# Whole platform: shared infra (RabbitMQ, Redis, edge) + every service in backend/.
# Each service also has its own Makefile for its migrations (backend/<service>/Makefile).
#
#   make up                 create missing .env files, build and start everything, then migrate every service
#   make watch              same, in the foreground with Compose Watch (code changes without rebuild)
#   make infra              start only the shared infra
#   make migrate            run the pending migrations of every service
#   make ps                 list the containers and their health
#   make logs [s=account-api]   follow the logs (of one container when s= is given)
#   make down               stop everything (volumes are kept)
#   make check              contract copies and repository root layout
#   make env                create each .env from its .env.example when it does not exist yet

COMPOSE = docker compose -f docker-compose.yml
SERVICES = $(patsubst %/Makefile,%,$(wildcard */Makefile))
ENV_EXAMPLES = $(wildcard infra/.env.example */.env.example */.env.test.example)

.PHONY: up watch infra migrate ps logs down check env

env:
	@for example in $(ENV_EXAMPLES); do \
	  target=$${example%.example}; \
	  if [ ! -f "$$target" ]; then cp "$$example" "$$target" && echo "created $$target"; fi; \
	done

up: env
	$(COMPOSE) up -d --build --wait
	@$(MAKE) --no-print-directory migrate

watch: env
	$(COMPOSE) up --build --watch

infra: env
	docker compose -f infra/docker-compose.yml up -d --wait

migrate:
	@for service in $(SERVICES); do \
	  echo "== $$service"; \
	  $(MAKE) --no-print-directory -C $$service migrate || exit 1; \
	done

ps:
	$(COMPOSE) ps --format 'table {{.Name}}\t{{.Status}}'

logs:
	$(COMPOSE) logs -f $(s)

down:
	$(COMPOSE) down

check:
	docker run --rm -v "$(CURDIR)/..":/repo -w /repo/backend node:26-alpine \
	  sh -c 'npx --yes tsx scripts/check-contracts.ts . && cd .. && sh backend/scripts/check-root-layout.sh .'
