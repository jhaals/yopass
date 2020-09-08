package server

import "github.com/jhaals/yopass/pkg/yopass"

// Database interface
type Database interface {
	Get(key string) (yopass.Secret, error)
	Put(key string, secret yopass.Secret) error
	Delete(key string) error
}
