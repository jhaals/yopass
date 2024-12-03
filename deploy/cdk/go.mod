module github.com/yopass/yopass-lambda

replace github.com/jhaals/yopass => ../../

require (
	github.com/akrylysov/algnhsa v0.12.1
	github.com/aws/aws-sdk-go v1.42.22
	github.com/jhaals/yopass v0.0.0-20211210123441-30470001a8f2
	github.com/prometheus/client_golang v1.20.5
	go.uber.org/zap v1.27.0
)

require (
	github.com/aws/aws-lambda-go v1.27.1 // indirect
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/bradfitz/gomemcache v0.0.0-20190913173617-a41fca850d0b // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/felixge/httpsnoop v1.0.4 // indirect
	github.com/go-redis/redis/v7 v7.4.1 // indirect
	github.com/gofrs/uuid v4.4.0+incompatible // indirect
	github.com/gorilla/handlers v1.5.2 // indirect
	github.com/gorilla/mux v1.8.1 // indirect
	github.com/jmespath/go-jmespath v0.4.0 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/prometheus/client_model v0.6.1 // indirect
	github.com/prometheus/common v0.55.0 // indirect
	github.com/prometheus/procfs v0.15.1 // indirect
	go.uber.org/multierr v1.10.0 // indirect
	golang.org/x/crypto v0.29.0 // indirect
	golang.org/x/sys v0.27.0 // indirect
	google.golang.org/protobuf v1.34.2 // indirect
)

go 1.21

toolchain go1.23.2
