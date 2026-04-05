package server

import (
	"encoding/json"
	"time"

	"github.com/go-redis/redis/v7"
	"github.com/jhaals/yopass/pkg/yopass"
)

// NewRedis returns a new Redis database client
func NewRedis(url string) (*Redis, error) {
	options, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	return &Redis{redis.NewClient(options)}, nil
}

// Redis client
type Redis struct {
	client *redis.Client
}

// Status returns secret metadata without deleting it (safe for one-time secrets).
func (r *Redis) Status(key string) (yopass.Secret, error) {
	var s yopass.Secret
	v, err := r.client.Get(key).Result()
	if err == redis.Nil {
		return s, redis.Nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal([]byte(v), &s); err != nil {
		return s, err
	}
	return s, nil
}

// Get key from Redis
func (r *Redis) Get(key string) (yopass.Secret, error) {
	var s yopass.Secret
	v, err := r.client.Get(key).Result()
	if err != nil {
		return s, err
	}

	if err := json.Unmarshal([]byte(v), &s); err != nil {
		return s, err
	}

	if s.OneTime {
		_, err := r.Delete(key)
		if err != nil {
			return s, err
		}
	}
	return s, nil
}

// Put key to Redis
func (r *Redis) Put(key string, secret yopass.Secret) error {
	data, err := secret.ToJSON()
	if err != nil {
		return err
	}
	return r.client.Set(
		key,
		data,
		time.Duration(secret.Expiration)*time.Second,
	).Err()
}

// Delete key from Redis
func (r *Redis) Delete(key string) (bool, error) {
	res, err := r.client.Del(key).Result()
	if err != nil {
		return false, err
	}
	return res == 1, nil
}

// Health checks Redis connectivity using PING command
func (r *Redis) Health() error {
	return r.client.Ping().Err()
}
