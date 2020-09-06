package main

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/akrylysov/algnhsa"
	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/jhaals/yopass/pkg/server"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
)

func main() {
	maxLength, _ := strconv.Atoi(os.Getenv("MAX_LENGTH"))
	if maxLength == 0 {
		maxLength = 10000
	}

	registry := prometheus.NewRegistry()
	y := server.New(NewDynamo(os.Getenv("TABLE_NAME")), maxLength, registry)

	algnhsa.ListenAndServe(
		y.HTTPHandler(),
		nil)
}

// Dynamo Database implementation
type Dynamo struct {
	tableName string
	svc       *dynamodb.DynamoDB
}

// NewDynamo returns a database client
func NewDynamo(tableName string) server.Database {
	return &Dynamo{tableName: tableName, svc: dynamodb.New(session.New())}
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
		if err := d.Delete(key); err != nil {
			return s, err
		}
	}
	s.Message = *result.Item["secret"].S
	return s, nil
}

// Delete item
func (d *Dynamo) Delete(key string) error {
	input := &dynamodb.DeleteItemInput{
		Key: map[string]*dynamodb.AttributeValue{
			"id": {
				S: aws.String(key),
			},
		},
		TableName: aws.String(d.tableName),
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
