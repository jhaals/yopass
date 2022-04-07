package server

import (
	"context"
	"github.com/jhaals/yopass/pkg/yopass"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/x/bsonx"
	"time"
)

func NewMongo(url string, dbName string, collection string) (Database, error) {
	client, err := mongo.Connect(context.TODO(), options.Client().ApplyURI(url))

	if err != nil {
		return nil, err
	}

	m := &Mongo{client, dbName, collection}
	err = m.ensureIndex()

	if err != nil {
		return nil, err
	}

	return m, nil
}

type Mongo struct {
	client     *mongo.Client
	dbName     string
	collection string
}

type MongoSecret struct {
	ID         string    `bson:"_id"`
	Message    string    `bson:"message"`
	OneTime    bool      `bson:"one_time,omitempty"`
	Expiration int32     `bson:"expiration,omitempty"`
	ExpiresAt  time.Time `bson:"expires_at,omitempty"`
}

func (s MongoSecret) toSecret() yopass.Secret {
	return yopass.Secret{
		Expiration: s.Expiration,
		Message:    s.Message,
		OneTime:    s.OneTime,
	}
}

func (m Mongo) ensureIndex() error {
	index := mongo.IndexModel{
		Keys:    bsonx.Doc{{Key: "expires_at", Value: bsonx.Int32(1)}},
		Options: options.Index().SetExpireAfterSeconds(0),
	}

	_, err := m.getCollection().Indexes().CreateOne(context.TODO(), index)

	if err != nil {
		return err
	}

	return nil
}

func (m Mongo) getCollection() *mongo.Collection {
	return m.client.Database(m.dbName).Collection(m.collection)
}

func (m Mongo) Get(key string) (yopass.Secret, error) {
	var s MongoSecret

	filter := bson.M{"_id": key}

	v := m.getCollection().FindOne(context.TODO(), filter)

	if v.Err() != nil {
		return yopass.Secret{}, v.Err()
	}

	err := v.Decode(&s)

	if err != nil {
		return yopass.Secret{}, err
	}

	if s.OneTime {
		_, err := m.Delete(key)

		if err != nil {
			return yopass.Secret{}, err
		}
	}

	return s.toSecret(), nil
}

func (m Mongo) Put(key string, secret yopass.Secret) error {

	d := time.Second * time.Duration(secret.Expiration)

	expireAt := time.Now().Add(d)

	s := MongoSecret{
		ID:         key,
		Message:    secret.Message,
		OneTime:    secret.OneTime,
		Expiration: secret.Expiration,
		ExpiresAt:  expireAt,
	}

	_, err := m.getCollection().InsertOne(context.TODO(), s)

	if err != nil {
		return err
	}

	return nil
}

func (m Mongo) Delete(key string) (bool, error) {
	filter := bson.M{"_id": key}

	_, err := m.getCollection().DeleteOne(context.TODO(), filter)

	if err != nil {
		return false, err
	}

	return true, err
}
