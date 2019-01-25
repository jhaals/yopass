workflow "Deploy service" {
  on = "push"
  resolves = ["deploy"]
}

action "detect-changes" {
  uses = "./.github/action-detect-changes"
}

action "build" {
  needs = ["detect-changes"]
  uses = "./.github/action-go-build"
}

action "deploy" {
  uses = "./.github/action-deploy"
  needs = ["detect-changes", "build"]
  secrets = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
}
