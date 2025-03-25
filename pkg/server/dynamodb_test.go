package server

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/jhaals/yopass/pkg/yopass"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
)

// MockDynamoDBClient is a mock implementation of DynamoDBClient interface
type MockDynamoDBClient struct {
	mock.Mock
}

func (m *MockDynamoDBClient) GetItem(ctx context.Context, params *dynamodb.GetItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	args := m.Called(ctx, params)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*dynamodb.GetItemOutput), args.Error(1)
}

func (m *MockDynamoDBClient) PutItem(ctx context.Context, params *dynamodb.PutItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	args := m.Called(ctx, params)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*dynamodb.PutItemOutput), args.Error(1)
}

func (m *MockDynamoDBClient) DeleteItem(ctx context.Context, params *dynamodb.DeleteItemInput, optFns ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	args := m.Called(ctx, params)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*dynamodb.DeleteItemOutput), args.Error(1)
}

func TestDynamoDB_Get(t *testing.T) {
	mockClient := new(MockDynamoDBClient)
	db := &DynamoDB{
		Client:    mockClient,
		TableName: "test-table",
	}

	tests := []struct {
		name    string
		key     string
		mock    func()
		want    yopass.Secret
		wantErr bool
	}{
		{
			name: "successful get",
			key:  "test-key",
			mock: func() {
				mockClient.On("GetItem", mock.Anything, &dynamodb.GetItemInput{
					Key: map[string]types.AttributeValue{
						"id": &types.AttributeValueMemberS{Value: "test-key"},
					},
					TableName: aws.String("test-table"),
				}).Return(&dynamodb.GetItemOutput{
					Item: map[string]types.AttributeValue{
						"id":         &types.AttributeValueMemberS{Value: "test-key"},
						"expiration": &types.AttributeValueMemberN{Value: "1234567890"},
						"message":    &types.AttributeValueMemberS{Value: "test-message"},
						"one_time":   &types.AttributeValueMemberBOOL{Value: false},
					},
				}, nil)
			},
			want: yopass.Secret{
				Expiration: 1234567890,
				Message:    "test-message",
				OneTime:    false,
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.mock()
			got, err := db.Get(tt.key)
			if tt.wantErr {
				assert.Error(t, err)
				return
			}
			assert.NoError(t, err)
			assert.Equal(t, tt.want, got)
			mockClient.AssertExpectations(t)
		})
	}
}

func TestDynamoDB_Get_OneTimeSecret(t *testing.T) {
	mockClient := new(MockDynamoDBClient)
	db := &DynamoDB{
		Client:    mockClient,
		TableName: "test-table",
	}

	tests := []struct {
		name    string
		key     string
		mock    func()
		want    yopass.Secret
		wantErr bool
	}{
		{
			name: "successful get",
			key:  "test-key",
			mock: func() {
				mockClient.On("GetItem", mock.Anything, &dynamodb.GetItemInput{
					Key: map[string]types.AttributeValue{
						"id": &types.AttributeValueMemberS{Value: "test-key"},
					},
					TableName: aws.String("test-table"),
				}).Return(&dynamodb.GetItemOutput{
					Item: map[string]types.AttributeValue{
						"id":         &types.AttributeValueMemberS{Value: "test-key"},
						"expiration": &types.AttributeValueMemberN{Value: "1234567890"},
						"message":    &types.AttributeValueMemberS{Value: "test-message"},
						"one_time":   &types.AttributeValueMemberBOOL{Value: true},
					},
				}, nil)
				mockClient.On("DeleteItem", mock.Anything, &dynamodb.DeleteItemInput{
					Key: map[string]types.AttributeValue{
						"id": &types.AttributeValueMemberS{Value: "test-key"},
					},
					TableName: aws.String("test-table"),
				}).Return(&dynamodb.DeleteItemOutput{}, nil)
			},
			want: yopass.Secret{
				Expiration: 1234567890,
				Message:    "test-message",
				OneTime:    true,
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.mock()
			got, err := db.Get(tt.key)
			if tt.wantErr {
				assert.Error(t, err)
				return
			}
			assert.NoError(t, err)
			assert.Equal(t, tt.want, got)
			mockClient.AssertExpectations(t)
		})
	}
}

func TestDynamoDB_Put(t *testing.T) {
	mockClient := new(MockDynamoDBClient)
	db := &DynamoDB{
		Client:    mockClient,
		TableName: "test-table",
	}

	tests := []struct {
		name    string
		key     string
		secret  yopass.Secret
		mock    func()
		wantErr bool
	}{
		{
			name: "successful put",
			key:  "test-key",
			secret: yopass.Secret{
				Expiration: int32(time.Now().Add(time.Hour).Unix()),
				Message:    "test-message",
				OneTime:    true,
			},
			mock: func() {
				mockClient.On("PutItem", mock.Anything, mock.Anything).Return(&dynamodb.PutItemOutput{}, nil)
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.mock()
			err := db.Put(tt.key, tt.secret)
			if tt.wantErr {
				assert.Error(t, err)
				return
			}
			assert.NoError(t, err)
			mockClient.AssertExpectations(t)
		})
	}
}

func TestDynamoDB_Delete(t *testing.T) {
	mockClient := new(MockDynamoDBClient)
	db := &DynamoDB{
		Client:    mockClient,
		TableName: "test-table",
	}

	tests := []struct {
		name    string
		key     string
		mock    func()
		want    bool
		wantErr bool
	}{
		{
			name: "successful delete",
			key:  "test-key",
			mock: func() {
				mockClient.On("DeleteItem", mock.Anything, &dynamodb.DeleteItemInput{
					Key: map[string]types.AttributeValue{
						"id": &types.AttributeValueMemberS{Value: "test-key"},
					},
					TableName: aws.String("test-table"),
				}).Return(&dynamodb.DeleteItemOutput{}, nil)
			},
			want:    true,
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.mock()
			got, err := db.Delete(tt.key)
			if tt.wantErr {
				assert.Error(t, err)
				return
			}
			assert.NoError(t, err)
			assert.Equal(t, tt.want, got)
			mockClient.AssertExpectations(t)
		})
	}
}
