package server

import (
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/jhaals/yopass/pkg/yopass"
)

// DynamoDB Database implementation
type DynamoDB struct {
	tableName string
	svc       *dynamodb.DynamoDB
}

// NewDynamoDB returns a database client
func NewDynamoDB(tableName string) Database {
	return &DynamoDB{tableName: tableName, svc: dynamodb.New(session.New())}
}

// Get item from dynamo
func (d *DynamoDB) Get(key string) (yopass.Secret, error) {
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
	return s, nil
}

// Delete item
func (d *DynamoDB) Delete(key string) (bool, error) {
	err := d.deleteItem(key)

	if errors.Is(err, &dynamodb.ResourceNotFoundException{}) {
		return false, nil
	}

	return err == nil, err
}

func (d *DynamoDB) deleteItem(key string) error {
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
func (d *DynamoDB) Put(key string, secret yopass.Secret) error {
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
