package yopass

import (
	"time"

	"github.com/go-redis/redis/v7"
)

// NewRedis returns a new Redis database client
func NewRedis(url string) (Database, error) {
	options, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(options)
	return &Redis{client}, nil
}

// Redis client
type Redis struct {
	client *redis.Client
}

// Get key from Redis
func (r *Redis) Get(key string) (string, error) {
	v, err := r.client.Get(key).Result()
	if err != nil {
		return "", err
	}
	return v, nil
}

// Put key to Redis
func (r *Redis) Put(key, value string, expiration int32) error {
	return r.client.Set(
		key,
		value,
		time.Duration(expiration)*time.Second,
	).Err()
}

// Delete key from Redis
func (r *Redis) Delete(key string) error {
	return r.client.Del(key).Err()
}
