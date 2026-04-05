package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/akrylysov/algnhsa"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/jhaals/yopass/pkg/server"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/spf13/viper"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

func main() {
	viper.AutomaticEnv()
	viper.SetEnvKeyReplacer(strings.NewReplacer("-", "_"))
	viper.SetDefault("cors-allow-origin", "*")
	viper.SetDefault("prefetch-secret", true)
	viper.SetDefault("max-length", 10000)
	viper.SetDefault("force-onetime-secrets", false)
	viper.SetDefault("max-file-size", "128KB")

	logger := configureZapLogger(zapcore.InfoLevel)

	maxFileSize, err := server.ParseSize(viper.GetString("max-file-size"))
	if err != nil {
		log.Fatalf("invalid max-file-size: %v", err)
	}

	db := NewDynamo(os.Getenv("TABLE_NAME"))
	registry := prometheus.NewRegistry()
	y := &server.Server{
		DB:                  db,
		FileStore:           server.NewDatabaseFileStore(db),
		MaxLength:           viper.GetInt("max-length"),
		MaxFileSize:         maxFileSize,
		Registry:            registry,
		ForceOneTimeSecrets: viper.GetBool("force-onetime-secrets"),
		Logger:              logger,
	}

	algnhsa.ListenAndServe(
		y.HTTPHandler(),
		&algnhsa.Options{
			BinaryContentTypes: []string{"application/octet-stream"},
		})
}

// Dynamo Database implementation
type Dynamo struct {
	tableName string
	svc       *dynamodb.DynamoDB
}

// NewDynamo returns a database client
func NewDynamo(tableName string) server.Database {
	sess, _ := session.NewSession()
	return &Dynamo{tableName: tableName, svc: dynamodb.New(sess)}
}

// Get item from dynamo
func (d *Dynamo) Get(key string) (yopass.Secret, error) {
	var s yopass.Secret
	input := &dynamodb.GetItemInput{
		Key: map[string]*dynamodb.AttributeValue{
			"id": {
				S: aws.String(key),
			},
		},
		TableName: aws.String(d.tableName),
	}
	result, err := d.svc.GetItem(input)
	if err != nil {
		return s, err
	}
	if len(result.Item) == 0 {
		return s, fmt.Errorf("Key not found in database")
	}

	if *result.Item["one_time"].BOOL {
		if err := d.deleteItem(key); err != nil {
			return s, err
		}
	}
	s.Message = *result.Item["secret"].S
	s.OneTime = *result.Item["one_time"].BOOL
	if v, ok := result.Item["require_auth"]; ok && v.BOOL != nil {
		s.RequireAuth = *v.BOOL
	}
	return s, nil
}

// Delete item
func (d *Dynamo) Delete(key string) (bool, error) {
	err := d.deleteItem(key)

	if errors.Is(err, &dynamodb.ResourceNotFoundException{}) {
		return false, nil
	}

	return err == nil, err
}

func (d *Dynamo) deleteItem(key string) error {
	input := &dynamodb.DeleteItemInput{
		Key: map[string]*dynamodb.AttributeValue{
			"id": {
				S: aws.String(key),
			},
		},
		TableName:    aws.String(d.tableName),
		ReturnValues: aws.String("ALL_OLD"),
	}

	_, err := d.svc.DeleteItem(input)
	return err
}

// Put item in Dynamo
func (d *Dynamo) Put(key string, secret yopass.Secret) error {
	input := &dynamodb.PutItemInput{
		// TABLE GENERATED NAME
		Item: map[string]*dynamodb.AttributeValue{
			"id": {
				S: aws.String(key),
			},
			"secret": {
				S: aws.String(secret.Message),
			},
			"one_time": {
				BOOL: aws.Bool(secret.OneTime),
			},
			"require_auth": {
				BOOL: aws.Bool(secret.RequireAuth),
			},
			"ttl": {
				N: aws.String(
					fmt.Sprintf(
						"%d", time.Now().Unix()+int64(secret.Expiration))),
			},
		},
		TableName: aws.String(d.tableName),
	}
	_, err := d.svc.PutItem(input)
	return err
}

// Status returns secret metadata without retrieving or deleting it (safe for one-time secrets).
func (d *Dynamo) Status(key string) (yopass.Secret, error) {
	input := &dynamodb.GetItemInput{
		Key: map[string]*dynamodb.AttributeValue{
			"id": {
				S: aws.String(key),
			},
		},
		TableName:            aws.String(d.tableName),
		ProjectionExpression: aws.String("one_time, require_auth"),
	}
	result, err := d.svc.GetItem(input)
	if err != nil {
		return yopass.Secret{}, err
	}
	if len(result.Item) == 0 {
		return yopass.Secret{}, fmt.Errorf("Key not found in database")
	}

	var s yopass.Secret
	if v, ok := result.Item["one_time"]; ok && v.BOOL != nil {
		s.OneTime = *v.BOOL
	}
	if v, ok := result.Item["require_auth"]; ok && v.BOOL != nil {
		s.RequireAuth = *v.BOOL
	}
	return s, nil
}

// Dummy health check
func (d *Dynamo) Health() error {
    return nil
}

func configureZapLogger(logLevel zapcore.Level) *zap.Logger {
	loggerCfg := zap.NewProductionConfig()
	loggerCfg.Level.SetLevel(logLevel)
	logger, err := loggerCfg.Build()
	if err != nil {
		log.Fatalf("Unable to build logger %v", err)
	}
	zap.ReplaceGlobals(logger)
	return logger
}
