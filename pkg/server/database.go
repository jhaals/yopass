package server

import (
	"context"
	// "github.com/3lvia/onetime-yopass/pkg/yopass"
	"github.com/3lvia/onetime-yopass/pkg/yopass"
)

// Database interface
type Database interface {
	Get(ctx context.Context, key string) (yopass.Secret, error)
	Put(ctx context.Context, key string, secret yopass.Secret) error
	Delete(ctx context.Context, key string) error
}
