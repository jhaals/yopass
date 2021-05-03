FROM golang:buster as app
RUN mkdir -p /yopass
WORKDIR /yopass
COPY . .
RUN go build ./cmd/yopass && go build ./cmd/yopass-server

FROM node as website
COPY website /website
WORKDIR /website
RUN yarn install && yarn build


FROM alpine:3 as runtime
LABEL maintainer="elvia@elvia.no"

RUN addgroup application-group --gid 1001 \
    && adduser application-user --uid 1001 \
    --ingroup application-group \
    --disabled-password

COPY --from=app /yopass/yopass /yopass/yopass-server /
COPY --from=website /website/build /public

RUN chown --recursive application-user .
USER application-user
ENTRYPOINT ["/yopass-server"]
