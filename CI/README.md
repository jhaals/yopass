```
helm template yopass -f CI/values.yaml elvia-deployment/elvia-deployment --set environment=dev --set image.tag=222>CI/manifest2.yaml
```
