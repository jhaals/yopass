FROM golang:buster as app
RUN mkdir -p /yopass
WORKDIR /yopass
COPY . .
RUN go build ./cmd/...

FROM node as website
COPY website /website
WORKDIR /website
RUN yarn install && yarn build

FROM gcr.io/distroless/base
COPY --from=app /yopass/yopass-server /
COPY --from=website /website/build /public
ENTRYPOINT ["/yopass-server"]
