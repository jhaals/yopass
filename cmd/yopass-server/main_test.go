package main

import (
	"testing"

	"github.com/spf13/viper"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"go.uber.org/zap/zaptest/observer"
)

func TestSetupDatabase(t *testing.T) {
	viper.Set("database", "memcached")
	viper.Set("memcached", "localhost:11211")

	core, logs := observer.New(zapcore.DebugLevel)
	logger := zap.New(core)

	db, _ := setupDatabase(logger)
	if db == nil {
		t.Fatal("Expected non-nil database")
	}

	if logs.FilterMessage("configured Memcached").Len() != 1 {
		t.Error("Expected log message 'configured Memcached'")
	}
}

func TestSetupDatabaseRedis(t *testing.T) {
	viper.Set("database", "redis")
	viper.Set("redis", "redis://localhost:6379/0")

	core, logs := observer.New(zapcore.DebugLevel)
	logger := zap.New(core)

	db, _ := setupDatabase(logger)
	if db == nil {
		t.Fatal("Expected non-nil database")
	}

	if logs.FilterMessage("configured Redis").Len() != 1 {
		t.Error("Expected log message 'configured Redis'")
	}
}

func TestSetupDatabaseRedisWithInvalidUrl(t *testing.T) {
	viper.Set("database", "redis")
	viper.Set("redis", "boop")

	core, _ := observer.New(zapcore.DebugLevel)
	logger := zap.New(core)

	_, err := setupDatabase(logger)
	expected := `invalid Redis URL: invalid redis URL scheme: `
	if err.Error() != expected {
		t.Fatalf("Expected '%s', got '%v'", expected, err.Error())
	}
}

func TestSetupDatabaseInvalid(t *testing.T) {
	viper.Set("database", "invalid")
	core, _ := observer.New(zapcore.DebugLevel)
	logger := zap.New(core)

	_, err := setupDatabase(logger)
	expected := `unsupported database, expected 'memcached' or 'redis' got 'invalid'`
	if err.Error() != expected {
		t.Fatalf("Expected '%s', got '%v'", expected, err.Error())
	}
}
