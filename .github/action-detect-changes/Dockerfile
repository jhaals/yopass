#FROM debian:9.5-slim
FROM alpine/git:1.0.4

LABEL "com.github.actions.name"="detect changes"
LABEL "com.github.actions.description"="Detect changes to .go files"
LABEL "com.github.actions.icon"="mic"
LABEL "com.github.actions.color"="purple"

LABEL "repository"="http://github.com/jhaals/actions"
LABEL "homepage"="http://github.com/jhaals/actions"
LABEL "maintainer"="Johan <johan@haals.se>"

ADD entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
