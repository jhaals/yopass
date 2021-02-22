module github.com/yopass/yopass-lambda

replace github.com/jhaals/yopass => ../../

require (
	github.com/akrylysov/algnhsa v0.12.1
	github.com/aws/aws-lambda-go v1.22.0 // indirect
	github.com/aws/aws-sdk-go v1.37.15
	github.com/go-sql-driver/mysql v1.5.0 // indirect
	github.com/jhaals/yopass v0.0.0-20210222054152-a5de5347ff14
	github.com/prometheus/client_golang v1.9.0
	google.golang.org/protobuf v1.25.0 // indirect
)

go 1.13
