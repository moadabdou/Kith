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

.PHONY: migrate-up migrate-down migrate-force psql
