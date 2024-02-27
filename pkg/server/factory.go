package server

import (
	"errors"
	"fmt"
	"github.com/spf13/viper"
	"go.uber.org/zap"
)

func NewDatabase(logger *zap.Logger) (Database, error) {
	var db Database

	switch database := viper.GetString("database"); database {

	case "memcached":
		memcached := viper.GetString("memcached")
		db = NewMemcached(memcached)
		logger.Debug("configured Memcached", zap.String("address", memcached))

	case "mongo":
		mongo := viper.GetString("mongo")
		dbName := viper.GetString("mongo-database")
		collection := viper.GetString("mongo-collection")

		var err error

		db, err = NewMongo(mongo, dbName, collection)

		if err != nil {
			return nil, err
		}

		logger.Debug("configured MongoDB", zap.String("address", mongo))

	case "redis":
		redis := viper.GetString("redis")
		var err error

		db, err = NewRedis(redis)

		if err != nil {
			return nil, err
		}

		logger.Debug("configured Redis", zap.String("url", redis))

	default:
		return nil, errors.New(fmt.Sprintf("unsupported database (%s), expected 'memcached', 'mongo' or 'redis'", database))
	}

	return db, nil
}
