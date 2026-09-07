package main

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/awserr"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/jhaals/yopass/pkg/server"
	"github.com/jhaals/yopass/pkg/yopass"
)

type dynamoClient interface {
	GetItem(*dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error)
	PutItem(*dynamodb.PutItemInput) (*dynamodb.PutItemOutput, error)
	DeleteItem(*dynamodb.DeleteItemInput) (*dynamodb.DeleteItemOutput, error)
}

type Dynamo struct {
	tableName string
	svc       dynamoClient
}

func NewDynamo(tableName string) server.Database {
	sess := session.Must(session.NewSession())
	return &Dynamo{tableName: tableName, svc: dynamodb.New(sess)}
}

func dynamoKey(key string) map[string]*dynamodb.AttributeValue {
	return map[string]*dynamodb.AttributeValue{"id": {S: aws.String(key)}}
}

// read rejects expired records even while DynamoDB's asynchronous TTL cleanup
// still retains them. Strong reads also avoid observing pre-update state.
func (d *Dynamo) read(key string) (map[string]*dynamodb.AttributeValue, yopass.Secret, error) {
	result, err := d.svc.GetItem(&dynamodb.GetItemInput{
		Key: dynamoKey(key), TableName: aws.String(d.tableName), ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, yopass.Secret{}, err
	}
	item := result.Item
	ttl := item["ttl"]
	if ttl == nil || ttl.N == nil {
		return nil, yopass.Secret{}, server.ErrKeyNotFound
	}
	expires, err := strconv.ParseInt(*ttl.N, 10, 64)
	now := time.Now().Unix()
	if err != nil || expires <= now || expires > now+math.MaxInt32 {
		return nil, yopass.Secret{}, server.ErrKeyNotFound
	}
	s := yopass.Secret{Expiration: int32(expires - now)}
	if v := item["secret"]; v != nil {
		s.Message = aws.StringValue(v.S)
	}
	if v := item["one_time"]; v != nil {
		s.OneTime = aws.BoolValue(v.BOOL)
	}
	if v := item["require_auth"]; v != nil {
		s.RequireAuth = aws.BoolValue(v.BOOL)
	}
	return item, s, nil
}

func (d *Dynamo) Status(key string) (yopass.Secret, error) {
	_, s, err := d.read(key)
	return s, err
}

func (d *Dynamo) Get(key string) (yopass.Secret, error) {
	s, err := d.Status(key)
	if err != nil {
		return yopass.Secret{}, err
	}
	if s.OneTime {
		deleted, err := d.Delete(key)
		if err != nil {
			return yopass.Secret{}, err
		}
		if !deleted {
			return yopass.Secret{}, server.ErrKeyNotFound
		}
	}
	return s, nil
}

// An existence condition makes deletion an exclusive one-time claim. An absent
// item must return false to the API handlers, not an unconditional-delete success.
func (d *Dynamo) Delete(key string) (bool, error) {
	result, err := d.svc.DeleteItem(&dynamodb.DeleteItemInput{
		Key: dynamoKey(key), TableName: aws.String(d.tableName), ReturnValues: aws.String(dynamodb.ReturnValueAllOld),
		ConditionExpression: aws.String("attribute_exists(id)"),
	})
	if err != nil {
		if conditionalCheckFailed(err) {
			return false, nil
		}
		return false, err
	}
	return len(result.Attributes) > 0, nil
}

func dynamoItem(key string, s yopass.Secret) (map[string]*dynamodb.AttributeValue, error) {
	// A fresh revision on every write prevents ABA conflicts, including records
	// deleted and recreated while an update is in flight.
	revision, err := yopass.GenerateID()
	if err != nil {
		return nil, err
	}
	return map[string]*dynamodb.AttributeValue{
		"id": {S: aws.String(key)}, "secret": {S: aws.String(s.Message)},
		"one_time": {BOOL: aws.Bool(s.OneTime)}, "require_auth": {BOOL: aws.Bool(s.RequireAuth)},
		"ttl":      {N: aws.String(strconv.FormatInt(time.Now().Unix()+int64(s.Expiration), 10))},
		"revision": {S: aws.String(revision)},
	}, nil
}

func (d *Dynamo) Put(key string, s yopass.Secret) error {
	item, err := dynamoItem(key, s)
	if err != nil {
		return err
	}
	_, err = d.svc.PutItem(&dynamodb.PutItemInput{TableName: aws.String(d.tableName), Item: item})
	return err
}

// Update implements the Database CAS contract across Lambda instances. Existing
// records without a revision acquire one on their first conditional update.
func (d *Dynamo) Update(key string, fn func(yopass.Secret) (yopass.Secret, error)) error {
	const retries = 5
	for attempt := 0; attempt < retries; attempt++ {
		old, s, err := d.read(key)
		if err != nil {
			return err
		}
		updated, err := fn(s)
		if err != nil {
			return err
		}
		item, err := dynamoItem(key, updated)
		if err != nil {
			return err
		}
		// Mutation processing time must never extend the original lifetime.
		oldExpiry, _ := strconv.ParseInt(*old["ttl"].N, 10, 64)
		newExpiry, _ := strconv.ParseInt(*item["ttl"].N, 10, 64)
		if newExpiry > oldExpiry {
			item["ttl"] = old["ttl"]
		}
		values := map[string]*dynamodb.AttributeValue{
			":now": {N: aws.String(strconv.FormatInt(time.Now().Unix(), 10))},
		}
		condition := "attribute_exists(id) AND #ttl > :now AND attribute_not_exists(revision)"
		if revision := old["revision"]; revision != nil {
			condition = "attribute_exists(id) AND #ttl > :now AND revision = :revision"
			values[":revision"] = revision
		}
		_, err = d.svc.PutItem(&dynamodb.PutItemInput{
			TableName: aws.String(d.tableName), Item: item,
			ConditionExpression:       aws.String(condition),
			ExpressionAttributeNames:  map[string]*string{"#ttl": aws.String("ttl")},
			ExpressionAttributeValues: values,
		})
		if err == nil {
			return nil
		}
		if !conditionalCheckFailed(err) {
			return err
		}
	}
	return fmt.Errorf("DynamoDB update contention exceeded %d attempts", retries)
}

func conditionalCheckFailed(err error) bool {
	var apiErr awserr.Error
	return errors.As(err, &apiErr) && apiErr.Code() == dynamodb.ErrCodeConditionalCheckFailedException
}

func (d *Dynamo) Health() error { return nil }
