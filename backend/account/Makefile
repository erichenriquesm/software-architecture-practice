# Laravel-style migration commands. They run inside the running account-api container
# (same image, same .env), so start the platform first: docker compose -f backend/docker-compose.yml up -d
#
#   make migrate                         run the pending migrations as one batch
#   make migrate-rollback                undo the last batch
#   make migrate-status                  list every migration and whether it ran
#   make migrate-fresh                   drop every table and migrate again
#   make migration name=create_x_table   create src/infra/database/migrations/<timestamp>_create_x_table.ts
#   make deps                            install node_modules and generate the gRPC code on your machine, for the editor

COMPOSE = docker compose -f ../docker-compose.yml
MIGRATIONS = src/infra/database/migrations

.PHONY: migrate migrate-rollback migrate-status migrate-fresh migration deps

migrate:
	$(COMPOSE) exec account-api npm run --silent migrate

migrate-rollback:
	$(COMPOSE) exec account-api npm run --silent migrate:rollback

migrate-status:
	$(COMPOSE) exec account-api npm run --silent migrate:status

migrate-fresh:
	$(COMPOSE) exec account-api npm run --silent migrate:fresh

migration:
	@test -n "$(name)" || (echo "usage: make migration name=create_x_table" && exit 1)
	$(COMPOSE) run --rm --no-deps -v $(CURDIR)/$(MIGRATIONS):/app/$(MIGRATIONS) account-api npm run --silent make:migration -- $(name)

# The editor reads node_modules and src/infra/generated from this folder; both are produced inside a
# container (same Node and protoc as the image), so nothing has to be installed on the host.
deps:
	docker run --rm -v "$(CURDIR)":/app -w /app node:26-alpine \
	  sh -c 'apk add --no-cache protobuf >/dev/null && npm ci --ignore-scripts --no-audit --no-fund && npm run --silent proto:gen'
