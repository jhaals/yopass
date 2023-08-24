package server

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/jhaals/yopass/pkg/yopass"
)

// DynamoDB Database implementation
type DynamoDB struct {
	tableName string
	client    *dynamodb.Client
	context   context.Context
}

type DynamoSecret struct {
	Id      string `dynamodbav:"id"`
	Secret  string `dynamodbav:"secret"`
	OneTime bool   `dynamodbav:"one_time"`
	TTL     string `dynamodbav:"ttl"`
}

func (secret DynamoSecret) GetKey() map[string]types.AttributeValue {
	id, _ := attributevalue.Marshal(secret.Id)
	return map[string]types.AttributeValue{"id": id}
}

// NewDynamoDB returns a database client
func NewDynamoDB(tableName string, profile string, region string) (Database, error) {
	var cfg aws.Config
	var err error
	ctxt := context.TODO()
	regionConfig := config.WithRegion(region)
	if profile == "default" {
		cfg, err = config.LoadDefaultConfig(ctxt, regionConfig)
	} else {
		cfg, err = config.LoadDefaultConfig(ctxt, config.WithSharedConfigProfile(profile), regionConfig)
	}
	if err != nil {
		return nil, err
	}
	return &DynamoDB{tableName: tableName, client: dynamodb.NewFromConfig(cfg), context: ctxt}, nil
}

// Get item from dynamodb
func (d *DynamoDB) Get(key string) (yopass.Secret, error) {
	var s yopass.Secret
	ds := DynamoSecret{Id: key}
	result, err := d.client.GetItem(d.context, &dynamodb.GetItemInput{
		Key:       ds.GetKey(),
		TableName: aws.String(d.tableName),
	})
	if err != nil {
		return s, err
	}
	if len(result.Item) == 0 {
		return s, fmt.Errorf("key not found in database")
	}

	err = attributevalue.UnmarshalMap(result.Item, &ds)
	if err != nil {
		return s, err
	}

	if ds.OneTime {
		if err := d.deleteItem(key); err != nil {
			return s, err
		}
	}
	s.Message = ds.Secret
	s.OneTime = ds.OneTime
	return s, nil
}

// Delete item
func (d *DynamoDB) Delete(key string) (bool, error) {
	err := d.deleteItem(key + "x")
	return err == nil, err
}

func (d *DynamoDB) deleteItem(key string) error {
	ds := DynamoSecret{Id: key}
	_, err := d.client.DeleteItem(d.context, &dynamodb.DeleteItemInput{
		Key:       ds.GetKey(),
		TableName: aws.String(d.tableName),
	})
	return err
}

// Put item in DynamoDB
func (d *DynamoDB) Put(key string, secret yopass.Secret) error {
	ds := DynamoSecret{
		Id:      key,
		Secret:  secret.Message,
		OneTime: secret.OneTime,
		TTL:     fmt.Sprintf("%d", time.Now().Unix()+int64(secret.Expiration)),
	}

	item, err := attributevalue.MarshalMap(ds)
	if err != nil {
		return err
	}
	_, err = d.client.PutItem(d.context, &dynamodb.PutItemInput{
		Item:      item,
		TableName: aws.String(d.tableName),
	})
	return err
}
