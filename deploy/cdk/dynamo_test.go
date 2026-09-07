package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go/aws"
	"github.com/aws/aws-sdk-go/aws/credentials"
	"github.com/aws/aws-sdk-go/aws/session"
	"github.com/aws/aws-sdk-go/service/dynamodb"
	"github.com/jhaals/yopass/pkg/server"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/prometheus/client_golang/prometheus"
	"go.uber.org/zap"
)

// Use DynamoDB Local so conditions, missing-item deletion, and concurrent
// writes are evaluated by DynamoDB rather than reimplemented in a test fake.
func testDynamo(t *testing.T) (*Dynamo, *dynamodb.DynamoDB) {
	t.Helper()
	endpoint := os.Getenv("DYNAMODB_ENDPOINT")
	if endpoint == "" {
		t.Skip("set DYNAMODB_ENDPOINT to run DynamoDB Local integration tests")
	}
	svc := dynamodb.New(session.Must(session.NewSession(&aws.Config{
		Endpoint: aws.String(endpoint), Region: aws.String("us-east-1"),
		Credentials: credentials.NewStaticCredentials("local", "local", ""),
		HTTPClient:  &http.Client{Timeout: 10 * time.Second}, MaxRetries: aws.Int(0),
	})))
	id, err := yopass.GenerateID()
	if err != nil {
		t.Fatal(err)
	}
	table := "security-" + id
	_, err = svc.CreateTable(&dynamodb.CreateTableInput{
		TableName: aws.String(table), BillingMode: aws.String("PAY_PER_REQUEST"),
		AttributeDefinitions: []*dynamodb.AttributeDefinition{{AttributeName: aws.String("id"), AttributeType: aws.String("S")}},
		KeySchema:            []*dynamodb.KeySchemaElement{{AttributeName: aws.String("id"), KeyType: aws.String("HASH")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := svc.DeleteTable(&dynamodb.DeleteTableInput{TableName: aws.String(table)}); err != nil {
			t.Error(err)
		}
	})
	return &Dynamo{tableName: table, svc: svc}, svc
}

// Hold the first two reads of key until both callers have the same snapshot.
// Separate Dynamo instances using this client model independent Lambda workers.
type simultaneousReads struct {
	dynamoClient
	key   string
	reads atomic.Int32
	ready chan struct{}
}

func (c *simultaneousReads) GetItem(in *dynamodb.GetItemInput) (*dynamodb.GetItemOutput, error) {
	out, err := c.dynamoClient.GetItem(in)
	if aws.StringValue(in.Key["id"].S) == c.key {
		switch c.reads.Add(1) {
		case 1:
			select {
			case <-c.ready:
			case <-time.After(10 * time.Second):
				return nil, errors.New("concurrent read did not arrive")
			}
		case 2:
			close(c.ready)
		}
	}
	return out, err
}

func TestDynamoOneTimeHTTP(t *testing.T) {
	for _, kind := range []string{"secret", "file", "request"} {
		t.Run(kind, func(t *testing.T) {
			db, svc := testDynamo(t)
			id := "12345678-1234-1234-1234-123456789012"
			key, path := id, "/secret/"+id
			secret := yopass.Secret{Message: "ciphertext", OneTime: true, Expiration: 3600}
			switch kind {
			case "file":
				key, path = "stream:"+id, "/file/"+id
				if err := db.Put("filedata:"+id, yopass.Secret{Message: "Y2lwaGVydGV4dA==", Expiration: 3600}); err != nil {
					t.Fatal(err)
				}
			case "request":
				key, path = "request/"+id, "/request/"+id+"/secret"
				hash := sha256.Sum256([]byte("management-token"))
				data, _ := json.Marshal(server.SecretRequest{
					TokenHash: hex.EncodeToString(hash[:]), State: server.RequestStateFulfilled,
					Secret: "ciphertext", ExpiresAt: time.Now().Unix() + 3600,
				})
				secret.Message = string(data)
			}
			if err := db.Put(key, secret); err != nil {
				t.Fatal(err)
			}
			barrier := &simultaneousReads{dynamoClient: svc, key: key, ready: make(chan struct{})}
			results := make(chan int, 2)
			for range 2 {
				y := &server.Server{
					DB: &Dynamo{tableName: db.tableName, svc: barrier}, Logger: zap.NewNop(),
					Registry: prometheus.NewRegistry(), License: server.LicenseStatus{Valid: true, ExpiresAt: time.Now().Add(time.Hour)},
				}
				handler := y.HTTPHandler()
				go func() {
					r := httptest.NewRequest(http.MethodGet, path, nil)
					r.Header.Set("X-Yopass-Request-Token", "management-token")
					w := httptest.NewRecorder()
					handler.ServeHTTP(w, r)
					results <- w.Code
				}()
			}
			a, b := <-results, <-results
			if !((a == 200 && b == 404) || (a == 404 && b == 200)) {
				t.Fatalf("one-time responses = %d, %d; want one 200 and one 404", a, b)
			}
			if deleted, err := db.Delete(key); deleted || err != nil {
				t.Fatalf("missing delete = %v, %v", deleted, err)
			}
		})
	}
}

func TestDynamoExpiration(t *testing.T) {
	db, svc := testDynamo(t)
	for _, ttl := range []string{"missing", "wrong-type", "1.5", "9223372036854775807", strconv.FormatInt(time.Now().Unix()-60, 10), strconv.FormatInt(time.Now().Unix(), 10)} {
		for _, prefix := range []string{"", "stream:", "filedata:"} {
			key := prefix + "expired"
			item, err := dynamoItem(key, yopass.Secret{Message: "ciphertext", Expiration: 3600})
			if err != nil {
				t.Fatal(err)
			}
			switch ttl {
			case "missing":
				delete(item, "ttl")
			case "wrong-type":
				item["ttl"] = &dynamodb.AttributeValue{S: aws.String(ttl)}
			default:
				item["ttl"] = &dynamodb.AttributeValue{N: aws.String(ttl)}
			}
			if _, err := svc.PutItem(&dynamodb.PutItemInput{TableName: aws.String(db.tableName), Item: item}); err != nil {
				t.Fatal(err)
			}
			for _, read := range []func(string) (yopass.Secret, error){db.Get, db.Status} {
				if s, err := read(key); !errors.Is(err, server.ErrKeyNotFound) || s.Message != "" {
					t.Fatalf("ttl %s: %v, %v", ttl, s, err)
				}
			}
			called := false
			err = db.Update(key, func(s yopass.Secret) (yopass.Secret, error) { called = true; return s, nil })
			if called || !errors.Is(err, server.ErrKeyNotFound) {
				t.Fatalf("expired update = %v, called=%v", err, called)
			}
		}
	}
	if err := db.Put("live", yopass.Secret{Message: "ciphertext", Expiration: 3600, RequireAuth: true}); err != nil {
		t.Fatal(err)
	}
	if s, err := db.Get("live"); err != nil || s.Message != "ciphertext" || !s.RequireAuth || s.Expiration <= 0 {
		t.Fatalf("live read = %+v, %v", s, err)
	}
}

func TestDynamoUpdateConcurrentFulfillment(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprintf("legacy=%v", legacy), func(t *testing.T) {
			db, svc := testDynamo(t)
			item, err := dynamoItem("request", yopass.Secret{Message: "pending", Expiration: 3600})
			if err != nil {
				t.Fatal(err)
			}
			if legacy {
				delete(item, "revision")
			}
			if _, err := svc.PutItem(&dynamodb.PutItemInput{TableName: aws.String(db.tableName), Item: item}); err != nil {
				t.Fatal(err)
			}
			barrier := &simultaneousReads{dynamoClient: svc, key: "request", ready: make(chan struct{})}
			results := make(chan error, 2)
			alreadyFulfilled := errors.New("already fulfilled")
			for range 2 {
				worker := &Dynamo{tableName: db.tableName, svc: barrier}
				go func() {
					results <- worker.Update("request", func(s yopass.Secret) (yopass.Secret, error) {
						if s.Message != "pending" {
							return s, alreadyFulfilled
						}
						s.Message = "fulfilled"
						return s, nil
					})
				}()
			}
			a, b := <-results, <-results
			if !((a == nil && errors.Is(b, alreadyFulfilled)) || (b == nil && errors.Is(a, alreadyFulfilled))) {
				t.Fatalf("updates = %v, %v", a, b)
			}
		})
	}
}

func TestDynamoUpdateRevocationAndExpiry(t *testing.T) {
	for _, change := range []string{"revoke", "expire", "replace", "abort"} {
		t.Run(change, func(t *testing.T) {
			db, svc := testDynamo(t)
			if err := db.Put("request", yopass.Secret{Message: "pending", Expiration: 3600}); err != nil {
				t.Fatal(err)
			}
			calls := 0
			abort := errors.New("abort")
			err := db.Update("request", func(s yopass.Secret) (yopass.Secret, error) {
				calls++
				if calls > 1 {
					return s, abort
				}
				switch change {
				case "revoke":
					if _, err := db.Delete("request"); err != nil {
						t.Fatal(err)
					}
				case "expire":
					// Expire the record without changing its revision to exercise
					// the server-side TTL condition independently of revision CAS.
					_, err := svc.UpdateItem(&dynamodb.UpdateItemInput{
						TableName: aws.String(db.tableName), Key: dynamoKey("request"),
						UpdateExpression:          aws.String("SET #ttl = :expired"),
						ExpressionAttributeNames:  map[string]*string{"#ttl": aws.String("ttl")},
						ExpressionAttributeValues: map[string]*dynamodb.AttributeValue{":expired": {N: aws.String("1")}},
					})
					if err != nil {
						t.Fatal(err)
					}
				case "replace":
					if err := db.Put("request", yopass.Secret{Message: "replacement", Expiration: 3600}); err != nil {
						t.Fatal(err)
					}
				case "abort":
					return s, abort
				}
				s.Message = "fulfilled"
				return s, nil
			})
			if change == "revoke" || change == "expire" {
				if !errors.Is(err, server.ErrKeyNotFound) {
					t.Fatalf("update = %v", err)
				}
				if _, err := db.Status("request"); !errors.Is(err, server.ErrKeyNotFound) {
					t.Fatalf("record resurrected: %v", err)
				}
			} else if !errors.Is(err, abort) {
				t.Fatalf("update = %v", err)
			} else {
				want := "pending"
				if change == "replace" {
					want = "replacement"
				}
				if s, err := db.Status("request"); err != nil || s.Message != want {
					t.Fatalf("aborted update changed record: %+v, %v", s, err)
				}
			}
		})
	}
}

func TestDynamoGetOneTime(t *testing.T) {
	db, svc := testDynamo(t)
	if err := db.Put("once", yopass.Secret{Message: "ciphertext", Expiration: 3600, OneTime: true}); err != nil {
		t.Fatal(err)
	}
	db.svc = &simultaneousReads{dynamoClient: svc, key: "once", ready: make(chan struct{})}
	results := make(chan error, 2)
	for range 2 {
		go func() {
			s, err := db.Get("once")
			if err != nil && s.Message != "" {
				t.Error("losing Get returned ciphertext")
			}
			results <- err
		}()
	}
	a, b := <-results, <-results
	if !((a == nil && errors.Is(b, server.ErrKeyNotFound)) || (b == nil && errors.Is(a, server.ErrKeyNotFound))) {
		t.Fatalf("Get claims = %v, %v", a, b)
	}
}

func TestDynamoUpdatePreservesExpiry(t *testing.T) {
	db, _ := testDynamo(t)
	if err := db.Put("request", yopass.Secret{Message: "pending", Expiration: 3600}); err != nil {
		t.Fatal(err)
	}
	old, _, err := db.read("request")
	if err != nil {
		t.Fatal(err)
	}
	err = db.Update("request", func(s yopass.Secret) (yopass.Secret, error) {
		s.Expiration = 604800
		return s, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	updated, _, err := db.read("request")
	if err != nil || aws.StringValue(updated["ttl"].N) != aws.StringValue(old["ttl"].N) {
		t.Fatalf("update extended expiry: %v", err)
	}
}

type failingDynamo struct {
	dynamoClient
	err error
}

func (c failingDynamo) DeleteItem(*dynamodb.DeleteItemInput) (*dynamodb.DeleteItemOutput, error) {
	return nil, c.err
}

func TestDynamoDeletePropagatesStorageErrors(t *testing.T) {
	failure := errors.New("storage unavailable")
	db := &Dynamo{svc: failingDynamo{err: failure}}
	if deleted, err := db.Delete("once"); deleted || !errors.Is(err, failure) {
		t.Fatalf("delete failed open: %v, %v", deleted, err)
	}
}
