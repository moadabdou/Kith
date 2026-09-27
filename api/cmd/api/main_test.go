package main

import (
	"testing"
	"time"
)

func setEnv(t *testing.T, key, value string) {
	t.Helper()
	t.Setenv(key, value)
}

func TestDBPoolConfigDefaults(t *testing.T) {
	cfg := dbPoolConfigFromEnv()
	if cfg.maxOpen != 25 || cfg.maxIdle != 25 || cfg.maxLifetime != 5*time.Minute {
		t.Fatalf("defaults = %+v, want 25/25/5m", cfg)
	}
}

func TestDBPoolConfigOverrides(t *testing.T) {
	setEnv(t, "PG_POOL_MAX_OPEN_CONNS", "10")
	setEnv(t, "PG_POOL_MAX_IDLE_CONNS", "5")
	setEnv(t, "PG_POOL_MAX_LIFETIME_SEC", "60")
	cfg := dbPoolConfigFromEnv()
	if cfg.maxOpen != 10 || cfg.maxIdle != 5 || cfg.maxLifetime != time.Minute {
		t.Fatalf("overrides = %+v, want 10/5/1m", cfg)
	}
}

func TestDBPoolConfigGarbageFallsBack(t *testing.T) {
	setEnv(t, "PG_POOL_MAX_OPEN_CONNS", "lots")
	setEnv(t, "PG_POOL_MAX_IDLE_CONNS", "-4")
	setEnv(t, "PG_POOL_MAX_LIFETIME_SEC", "0")
	cfg := dbPoolConfigFromEnv()
	if cfg.maxOpen != 25 || cfg.maxIdle != 25 || cfg.maxLifetime != 5*time.Minute {
		t.Fatalf("garbage = %+v, want defaults 25/25/5m", cfg)
	}
}

func TestEnvInt(t *testing.T) {
	setEnv(t, "TEST_INT_X92", "42")
	if got := envInt("TEST_INT_X92", 7); got != 42 {
		t.Fatalf("envInt = %d, want 42", got)
	}
	if got := envInt("TEST_INT_X92_UNSET", 7); got != 7 {
		t.Fatalf("envInt unset = %d, want 7", got)
	}
}
