FROM golang:buster as app
RUN mkdir -p /yopass
WORKDIR /yopass
COPY . .
ARG TARGETOS TARGETARCH
# /yopass Trace/breakpoint trap (core dumped) on amd64
#RUN GOOS=$TARGETOS GOARCH=$TARGETARCH CGO_ENABLED=0 \
# go build -ldflags "-linkmode 'external' -extldflags '-static'" ./cmd/yopass && \
# go build -ldflags "-linkmode 'external' -extldflags '-static'" ./cmd/yopass-server
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH \
 go build ./cmd/yopass && \
 go build ./cmd/yopass-server


FROM --platform=$BUILDPLATFORM node:16 as website
COPY website /website
WORKDIR /website
# 2024-01-04 Force yarn to generate yarn.lock to match package.json
# which has been modified due to 
# https://github.com/react-hook-form/react-hook-form/issues/11281#issuecomment-1852745400
# Otherwise, image won't build on arm64
#	RUN rm yarn.lock
RUN yarn install --network-timeout 600000 && yarn build

# To avoid hassles and pitfalls of statically-linked binaries
#FROM gcr.io/distroless/base:debug as final
FROM debian:buster as final
ENV COMMIT_HASH=COMMIT_HASH_REPLACE
ENV SHA_HASH_VERSION=SHA_HASH_VERSION_REPLACE
COPY --from=app /yopass/yopass /yopass/yopass-server /
COPY --from=website /website/build /public
COPY --from=website /website/yarn.lock /yarn.lock
ENTRYPOINT ["/yopass-server"]
