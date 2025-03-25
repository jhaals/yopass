package server

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/bradfitz/gomemcache/memcache"
	"github.com/jhaals/yopass/pkg/yopass"
)

const (
	DEFAULT_REGION = "eu-north-1"
)

// DynamoDBClient interface defines the methods we need from the DynamoDB client
type DynamoDBClient interface {
	GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error)
	PutItem(ctx context.Context, params *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error)
	DeleteItem(ctx context.Context, params *dynamodb.DeleteItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error)
}

// NewDynamoDB returns a new DynamoDB database client
func NewDynamoDB(tableName string, roleArn string) (Database, error) {
	awsConfig, err := config.LoadDefaultConfig(context.Background(), config.WithRegion(DEFAULT_REGION))
	if err != nil {
		return nil, errors.New("failed to load AWS configuration: " + err.Error())
	}

	if roleArn != "" {
		stsClient := sts.NewFromConfig(awsConfig)
		awsConfig.Credentials = stscreds.NewAssumeRoleProvider(stsClient, roleArn)
	}

	dynamodbClient := dynamodb.NewFromConfig(awsConfig)

	describeTableInput := &dynamodb.DescribeTableInput{
		TableName: aws.String(tableName),
	}

	_, err = dynamodbClient.DescribeTable(context.Background(), describeTableInput)
	if err != nil {
		return nil, err
	}

	return &DynamoDB{
		Client:    dynamodbClient,
		TableName: tableName,
	}, nil
}

// DynamoDB client
type DynamoDB struct {
	Client    DynamoDBClient
	TableName string
}

// Get key in DynamoDB
func (m *DynamoDB) Get(key string) (yopass.Secret, error) {
	var s yopass.Secret

	r, err := m.Client.GetItem(context.Background(), &dynamodb.GetItemInput{
		Key: map[string]types.AttributeValue{
			"id": &types.AttributeValueMemberS{Value: key},
		},
		TableName: aws.String(m.TableName),
	})
	if err != nil {
		return s, err
	}

	if r.Item == nil {
		return s, errors.New("secret not found")
	}

	expiration, _ := strconv.ParseInt(r.Item["expiration"].(*types.AttributeValueMemberN).Value, 10, 32)
	s = yopass.Secret{
		Expiration: int32(expiration),
		Message:    r.Item["message"].(*types.AttributeValueMemberS).Value,
		OneTime:    r.Item["one_time"].(*types.AttributeValueMemberBOOL).Value,
	}

	if s.OneTime {
		if _, err := m.Delete(key); err != nil {
			return s, err
		}
	}

	return s, nil
}

// Put key in DynamoDB
func (m *DynamoDB) Put(key string, secret yopass.Secret) error {
	expiration := time.Now().Add(time.Duration(secret.Expiration) * time.Second).Unix()
	_, err := m.Client.PutItem(context.Background(), &dynamodb.PutItemInput{
		TableName: aws.String(m.TableName),
		Item: map[string]types.AttributeValue{
			"id":         &types.AttributeValueMemberS{Value: key},
			"expiration": &types.AttributeValueMemberN{Value: strconv.FormatInt(expiration, 10)},
			"message":    &types.AttributeValueMemberS{Value: secret.Message},
			"one_time":   &types.AttributeValueMemberBOOL{Value: secret.OneTime},
		},
	})

	if err != nil {
		return err
	}

	return nil
}

// Delete key from DynamoDB
func (m *DynamoDB) Delete(key string) (bool, error) {
	_, err := m.Client.DeleteItem(context.Background(), &dynamodb.DeleteItemInput{
		TableName: aws.String(m.TableName),
		Key: map[string]types.AttributeValue{
			"id": &types.AttributeValueMemberS{Value: key},
		},
	})

	if err == memcache.ErrCacheMiss {
		return false, nil
	}

	return err == nil, err
}
