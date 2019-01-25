
FROM golang:1-stretch

LABEL version="1.0.0"
LABEL repository="https://github.com/jhaals/yopass"
LABEL homepage="https://github.com/jhaals/yopass"
LABEL maintainer="Johan <johan@haals.se>"

LABEL "com.github.actions.name"="GitHub Action for Go build"
LABEL "com.github.actions.description"="Builds yopass"
LABEL "com.github.actions.icon"="zap"
LABEL "com.github.actions.color"="blue"

ADD entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]