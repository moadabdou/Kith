-include .env
export

POSTGRES_USER ?= discord
POSTGRES_PASSWORD ?= discord
POSTGRES_DB ?= discord

DB_URL = postgres://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@postgres:5432/$(POSTGRES_DB)?sslmode=disable
MIGRATE = docker compose run --rm migrate -path /migrations -database $(DB_URL)

migrate-up:
	$(MIGRATE) up

migrate-down:
	$(MIGRATE) down 1

migrate-force:
	$(MIGRATE) force $(v)

psql:
	docker compose exec postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

cqlsh:
	docker compose exec scylla cqlsh

scylla-status:
	docker compose exec scylla nodetool status

gateway-test:
	docker build --target test -t kith-gateway-test gateway
	docker run --rm --network host -v $(CURDIR)/testvectors:/app/testvectors:ro -e PORT=0 kith-gateway-test

smoke:
	./scripts/smoke.sh

chaos-phase0:
	./scripts/chaos/phase0_kill_api.sh

bench-messages-setup:
	./scripts/bench/setup_bench.sh

bench-messages-load:
	./scripts/bench/run_load_test.sh

bench-search-cliff:
	./scripts/bench/pg_trgm_cliff.sh

init-meilisearch:
	./scripts/init_meilisearch.sh

.PHONY: migrate-up migrate-down migrate-force psql cqlsh scylla-status gateway-test smoke chaos-phase0 bench-messages-setup bench-messages-load bench-search-cliff init-meilisearch
