package server

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/go-redis/redis/v7"
	"github.com/jhaals/yopass/pkg/yopass"
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
		res, err := r.client.Del(key).Result()
		if err != nil {
			return s, err
		}
		if res != 1 {
			return s, fmt.Errorf("expected to delete 1 key, but deleted %d keys", res)
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
	if res != 1 {
		return false, fmt.Errorf("expected to delete 1 key, but deleted %d keys", res)
	}
	if err == redis.Nil {
		return false, nil
	}

	return err == nil, err
}
