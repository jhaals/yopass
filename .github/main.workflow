workflow "Deploy service" {
  on = "push"
  resolves = ["deploy"]
}

action "deploy" {
  uses = "./.github/action-deploy"
  secrets = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
}
