package yopass

// Database interface
type Database interface {
	Get(key string) (string, error)
	Put(key, value string, expiration int32) error
	Delete(key string) error
}
