package server

import (
	"encoding/json"
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

// Status returns whether the secret exists and if it is one-time
func (r *Redis) Status(key string) (bool, error) {
	v, err := r.client.Get(key).Result()
	if err == redis.Nil {
		return false, redis.Nil
	}
	if err != nil {
		return false, err
	}
	var s yopass.Secret
	if err := json.Unmarshal([]byte(v), &s); err != nil {
		return false, err
	}
	return s.OneTime, nil
}

// getAndDeleteScript atomically gets a key's value and deletes it if the
// secret is marked as one-time. This prevents race conditions where two
// concurrent requests could both read a one-time secret before either deletes it.
var getAndDeleteScript = redis.NewScript(`
	local val = redis.call("GET", KEYS[1])
	if val == false then
		return nil
	end
	local obj = cjson.decode(val)
	if obj["one_time"] then
		redis.call("DEL", KEYS[1])
	end
	return val
`)

// Get key from Redis
func (r *Redis) Get(key string) (yopass.Secret, error) {
	var s yopass.Secret
	v, err := getAndDeleteScript.Run(r.client, []string{key}).Result()
	if err == redis.Nil {
		return s, redis.Nil
	}
	if err != nil {
		return s, err
	}

	if err := json.Unmarshal([]byte(v.(string)), &s); err != nil {
		return s, err
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
	if res == 0 {
		return false, nil
	}
	return true, nil
}
