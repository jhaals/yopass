module github.com/yopass/yopass-lambda

replace github.com/jhaals/yopass => ../../

require (
	github.com/akrylysov/algnhsa v0.12.1
	github.com/aws/aws-lambda-go v1.27.1 // indirect
	github.com/aws/aws-sdk-go v1.42.22
	github.com/felixge/httpsnoop v1.0.2 // indirect
	github.com/jhaals/yopass v0.0.0-20211210123441-30470001a8f2
	github.com/prometheus/client_golang v1.13.1
	go.uber.org/zap v1.23.0
	golang.org/x/sys v0.1.0 // indirect
)

go 1.16
