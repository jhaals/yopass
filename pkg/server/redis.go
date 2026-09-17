package server

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/redis/go-redis/v9"
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
	v, err := r.client.Get(context.Background(), key).Result()
	if err == redis.Nil {
		return s, ErrKeyNotFound
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal([]byte(v), &s); err != nil {
		return s, err
	}
	return s, nil
}

// Get returns a secret, atomically claiming one-time values before delivery.
func (r *Redis) Get(key string) (yopass.Secret, error) {
	return r.GetAuthorized(key, func(yopass.Secret) error { return nil })
}

// WATCH begins before reading so even an identical-value rewrite invalidates
// the claim. Authorization and delivery use this same snapshot.
func (r *Redis) GetAuthorized(key string, authorize func(yopass.Secret) error) (yopass.Secret, error) {
	ctx := context.Background()
	var secret yopass.Secret
	err := r.client.Watch(ctx, func(tx *redis.Tx) error {
		value, err := tx.Get(ctx, key).Result()
		if err == redis.Nil {
			return ErrKeyNotFound
		}
		if err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(value), &secret); err != nil {
			return err
		}
		if err := authorize(secret); err != nil {
			return err
		}
		if !secret.OneTime {
			return nil
		}
		var deleted *redis.IntCmd
		_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
			deleted = pipe.Del(ctx, key)
			return nil
		})
		if err != nil {
			return err
		}
		if deleted.Val() != 1 {
			return ErrKeyNotFound
		}
		return nil
	}, key)
	if err == redis.TxFailedErr {
		err = ErrKeyNotFound
	}
	if err != nil {
		return yopass.Secret{}, err
	}
	return secret, nil
}

// Put key to Redis
func (r *Redis) Put(key string, secret yopass.Secret) error {
	data, err := secret.ToJSON()
	if err != nil {
		return err
	}
	return r.client.Set(
		context.Background(),
		key,
		data,
		time.Duration(secret.Expiration)*time.Second,
	).Err()
}

// Update atomically applies fn to the value at key using an optimistic
// WATCH/MULTI/EXEC transaction, retrying on contention.
func (r *Redis) Update(key string, fn func(yopass.Secret) (yopass.Secret, error)) error {
	ctx := context.Background()
	var lastErr error
	for i := 0; i < updateRetries; i++ {
		err := r.client.Watch(ctx, func(tx *redis.Tx) error {
			v, err := tx.Get(ctx, key).Result()
			if err == redis.Nil {
				return ErrKeyNotFound
			}
			if err != nil {
				return err
			}
			var s yopass.Secret
			if err := json.Unmarshal([]byte(v), &s); err != nil {
				return err
			}
			updated, err := fn(s)
			if err != nil {
				return err
			}
			data, err := updated.ToJSON()
			if err != nil {
				return err
			}
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				pipe.Set(ctx, key, data, time.Duration(updated.Expiration)*time.Second)
				return nil
			})
			return err
		}, key)
		if err != redis.TxFailedErr {
			return err
		}
		lastErr = err
	}
	return lastErr
}

// Delete key from Redis
func (r *Redis) Delete(key string) (bool, error) {
	res, err := r.client.Del(context.Background(), key).Result()
	if err != nil {
		return false, err
	}
	return res == 1, nil
}

// Health checks Redis connectivity using PING command
func (r *Redis) Health() error {
	return r.client.Ping(context.Background()).Err()
}
