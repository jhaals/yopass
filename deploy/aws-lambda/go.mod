module github.com/yopass/yopass-lambda

replace github.com/jhaals/yopass => ../../

require (
	github.com/akrylysov/algnhsa v0.12.1
	github.com/aws/aws-lambda-go v1.26.0 // indirect
	github.com/aws/aws-sdk-go v1.40.43
	github.com/cespare/xxhash/v2 v2.1.2 // indirect
	github.com/felixge/httpsnoop v1.0.2 // indirect
	github.com/jhaals/yopass v0.0.0-20210916074044-f55704ca3135
	github.com/prometheus/client_golang v1.11.0
	github.com/prometheus/common v0.30.0 // indirect
	github.com/prometheus/procfs v0.7.3 // indirect
	golang.org/x/crypto v0.0.0-20210915214749-c084706c2272 // indirect
	golang.org/x/sys v0.0.0-20210915083310-ed5796bab164 // indirect
	google.golang.org/protobuf v1.27.1 // indirect
)

go 1.16
