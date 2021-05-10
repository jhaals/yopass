package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"log"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/3lvia/onetime-yopass/pkg/yopass"
)

// NewRedis returns a new Redis database client
func NewRedis(url string, password string) (Database, error) {
	// redisHost := os.Getenv("REDIS_HOST")
	// redisPassword := os.Getenv("REDIS_PASSWORD")

	op := &redis.Options{Addr: url, Password: password, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}, WriteTimeout: 5 * time.Second}
	client := redis.NewClient(op)

	ctx := context.Background()
	err := client.Ping(ctx).Err()
	if err != nil {
		log.Fatalf("failed to connect with redis instance at %s - %v", url, err)
	}

	return &Redis{client}, nil
}

// Redis client
type Redis struct {
	client *redis.Client
}

// Get key from Redis
func (r *Redis) Get(ctx context.Context, key string) (yopass.Secret, error) {
	var s yopass.Secret
	v, err := r.client.Get(ctx, key).Result()
	if err != nil {
		return s, err
	}

	if err := json.Unmarshal([]byte(v), &s); err != nil {
		return s, err
	}

	if s.OneTime {
		if err := r.Delete(ctx, key); err != nil {
			return s, err
		}
	}

	return s, nil
}

// Put key to Redis
func (r *Redis) Put(ctx context.Context, key string, secret yopass.Secret) error {
	data, err := secret.ToJSON()
	if err != nil {
		return err
	}
	return r.client.Set(
		ctx,
		key,
		data,
		time.Duration(secret.Expiration)*time.Second,
	).Err()
}

// Delete key from Redis
func (r *Redis) Delete(ctx context.Context, key string) error {
	return r.client.Del(ctx, key).Err()
}
