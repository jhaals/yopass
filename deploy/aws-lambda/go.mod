module github.com/yopass/yopass-lambda

replace github.com/jhaals/yopass => ../../

require (
	github.com/akrylysov/algnhsa v0.12.1
	github.com/aws/aws-lambda-go v1.27.1 // indirect
	github.com/aws/aws-sdk-go v1.42.22
	github.com/felixge/httpsnoop v1.0.2 // indirect
	github.com/jhaals/yopass v0.0.0-20230112131718-461243e529a4
	github.com/prometheus/client_golang v1.13.1
	go.uber.org/zap v1.23.0
)

go 1.16
