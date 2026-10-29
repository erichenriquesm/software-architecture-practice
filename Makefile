# The whole project from the root: the backend platform (backend/Makefile) and the web client (frontend/Makefile).
# Each service and the front live in their own repository (repos.txt); `make clone` brings them here.
# What belongs to one side only stays in its own Makefile (backend: migrate, infra, watch, projections-rebuild;
# frontend: screens, readme-media, build).
#
#   make clone              clone the repositories that are not here yet (backend/<service>/ and frontend/)
#   make pull               update every cloned repository (git pull --ff-only)
#   make up                 backend (.env, infra, services, migrations) and then the front on http://localhost:5173
#   make down               stop the front and the backend (volumes are kept)
#   make ps                 containers of the backend and of the front, with their health
#   make logs [s=account-api]   follow the backend logs (one container when s= is given; s=frontend for the front)
#   make test               every test that needs no running platform: each service, contracts, the front's unit tests, root layout
#   make e2e                start everything, then the backend end-to-end tests and the front's Playwright tests
#   make check              contract copies and repository root layout
#   make deps               node_modules on your machine of every service and of the front, for the editor

BACK = $(MAKE) --no-print-directory -C backend
FRONT = $(MAKE) --no-print-directory -C frontend

.PHONY: clone pull up down ps logs test e2e check layout deps

# A folder may already exist with only a placeholder (frontend/.gitkeep): the repository is initialised inside it.
clone:
	@grep -v '^#' repos.txt | while read -r folder url; do \
	  if [ -d "$$folder/.git" ]; then echo "$$folder: already cloned"; continue; fi; \
	  mkdir -p "$$folder" && git -C "$$folder" init --quiet && git -C "$$folder" remote add origin "$$url" && \
	  git -C "$$folder" fetch --quiet origin && git -C "$$folder" checkout --quiet -t origin/main && echo "$$folder: cloned"; \
	done

pull:
	@grep -v '^#' repos.txt | while read -r folder url; do \
	  if [ -d "$$folder/.git" ]; then echo "== $$folder"; git -C "$$folder" pull --ff-only || exit 1; fi; \
	done

up:
	@$(BACK) up
	@$(FRONT) up

down:
	@$(FRONT) down
	@$(BACK) down

ps:
	@$(BACK) ps
	@$(FRONT) ps

logs:
ifeq ($(s),frontend)
	@$(FRONT) logs
else
	@$(BACK) logs s=$(s)
endif

test:
	@$(BACK) test
	@$(FRONT) test-unit
	@$(MAKE) --no-print-directory layout

e2e:
	@$(BACK) e2e
	@$(FRONT) up
	@$(FRONT) e2e

check:
	@$(BACK) check
	@$(MAKE) --no-print-directory layout

deps:
	@$(BACK) deps
	@$(FRONT) deps

# Only backend/, frontend/, sdd/ and the files of this root (sdd/04-ambiente-docker.md §0).
ROOT_ENTRIES = .git .claude .planning .DS_Store .gitignore README.md Makefile repos.txt backend frontend sdd

layout:
	@extra=$$(ls -A | grep -vxF $(foreach entry,$(ROOT_ENTRIES),-e $(entry))); \
	if [ -n "$$extra" ]; then echo "unexpected entries in the repository root: $$extra"; exit 1; fi; \
	echo "root layout ok"
