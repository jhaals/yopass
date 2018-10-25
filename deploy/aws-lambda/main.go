package main

import (
	"os"

	"github.com/akrylysov/algnhsa"
	"github.com/jhaals/yopass/pkg/yopass"
)

func main() {
	algnhsa.ListenAndServe(
		yopass.HTTPHandler(NewDynamo(os.Getenv("TABLE_NAME"))),
		nil)
}
